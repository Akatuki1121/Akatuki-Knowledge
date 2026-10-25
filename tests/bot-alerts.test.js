// Issue #86: src/bot-alerts.mjs のモジュール契約テスト。
// ボットアラート (運用通知) を index.js から分離したため、文字列抽出ではなく
// モジュールの振る舞いで検証する。アラートは #63 の運用失敗通知経路であり、
// 壊れても利用者には見えず静かに滞留するため、claim / 再試行の契約を固定する。
// D1 はインメモリフェイクで bot_alerts の SQL 意味論を再現する。
// 実装は new Date() / Date.now() を直接使うため、フィクスチャは現在時刻前後で組む
// (時計注入のリファクタはこの抽出には混ぜない)。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBotAlerts } from "../src/bot-alerts.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
// enqueueBotAlert は organize runner へも注入されるため、実体化がそれより前にあることも見る。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./bot-alerts.mjs"'), "the Worker entry point must import the bot alerts module");
assert.ok(workerSource.includes("createBotAlerts({ sendTelegramMessage })"), "the Worker entry point must build bot alerts through the factory with the Telegram sender injected");
assert.ok(
  workerSource.indexOf("createBotAlerts({ sendTelegramMessage })") < workerSource.indexOf("createOrganizeRunner({"),
  "bot alerts must be built before the organize runner consumes enqueueBotAlert"
);

const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();
const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

// bot_alerts テーブルのインメモリフェイク。prepare される SQL の意味論だけを再現し、
// 実行された文と bind を記録する。failOn に文の断片を入れるとその文で例外を投げる。
function createFakeDb({ failOn = null } = {}) {
  const rows = new Map();
  const calls = [];
  const matches = (sql) => failOn && sql.includes(failOn);
  function prepare(sql) {
    return {
      bind(...args) {
        calls.push({ sql, args });
        return {
          async run() {
            if (matches(sql)) throw new Error("fake D1 failure");
            if (sql.includes("INSERT INTO bot_alerts")) {
              const [alertKey, category, firstSeenAt, lastSeenAt, nextAttemptAt] = args;
              const existing = rows.get(alertKey);
              if (existing) {
                existing.last_seen_at = lastSeenAt;
                existing.occurrences += 1;
              } else {
                rows.set(alertKey, {
                  alert_key: alertKey, category, first_seen_at: firstSeenAt, last_seen_at: lastSeenAt,
                  occurrences: 1, status: "pending", next_attempt_at: nextAttemptAt,
                  send_attempts: 0, claim_expires_at: null, sent_at: null
                });
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'sending'")) {
              const [claimExpiresAt, alertKey, pendingNow, sendingNow] = args;
              const row = rows.get(alertKey);
              const claimable = row && ((row.status === "pending" && row.next_attempt_at <= pendingNow)
                || (row.status === "sending" && row.claim_expires_at && row.claim_expires_at <= sendingNow));
              if (!claimable) return { meta: { changes: 0 } };
              row.status = "sending";
              row.claim_expires_at = claimExpiresAt;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'sent'")) {
              const [sentAt, alertKey] = args;
              const row = rows.get(alertKey);
              if (!row || row.status !== "sending") return { meta: { changes: 0 } };
              row.status = "sent";
              row.sent_at = sentAt;
              row.claim_expires_at = null;
              row.send_attempts += 1;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'pending'")) {
              const [attempts, nextAttemptAt, alertKey] = args;
              const row = rows.get(alertKey);
              if (!row || row.status !== "sending") return { meta: { changes: 0 } };
              row.status = "pending";
              row.claim_expires_at = null;
              row.send_attempts = attempts;
              row.next_attempt_at = nextAttemptAt;
              return { meta: { changes: 1 } };
            }
            throw new Error(`unexpected SQL in fake D1 run(): ${sql.slice(0, 80)}`);
          },
          async all() {
            if (matches(sql)) throw new Error("fake D1 failure");
            if (sql.includes("SELECT alert_key")) {
              const [pendingNow, sendingNow, limit] = args;
              const selected = [...rows.values()]
                .filter((row) => (row.status === "pending" && row.next_attempt_at <= pendingNow)
                  || (row.status === "sending" && row.claim_expires_at && row.claim_expires_at <= sendingNow))
                .sort((a, b) => (a.first_seen_at < b.first_seen_at ? -1 : 1))
                .slice(0, limit)
                .map((row) => ({ alert_key: row.alert_key, category: row.category, occurrences: row.occurrences, send_attempts: row.send_attempts }));
              return { results: selected };
            }
            throw new Error(`unexpected SQL in fake D1 all(): ${sql.slice(0, 80)}`);
          }
        };
      }
    };
  }
  return { DB: { prepare }, rows, calls };
}

function seedAlert(rows, overrides = {}) {
  const row = {
    alert_key: "gemini_limit:2026-10-25", category: "gemini_limit",
    first_seen_at: past(120_000), last_seen_at: past(120_000), occurrences: 1,
    status: "pending", next_attempt_at: past(), send_attempts: 0,
    claim_expires_at: null, sent_at: null, ...overrides
  };
  rows.set(row.alert_key, row);
  return row;
}

function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  return { lines, restore: () => { console.error = original; } };
}

const TEXTS = {
  gemini_limit: "Geminiの利用上限またはレート制限でAI処理が止まったよ。保存済みのノートはD1に残し、再試行を続けるね。",
  configuration: "AI処理に必要な設定が見つからず、自動整理が止まっているよ。設定が戻れば再試行するね。",
  processing_failure: "自動整理に失敗したよ。ノートはD1に残して、次の再試行に回したよ。原因はまだ特定できていないよ。"
};

test("alertWindowKey: カテゴリと UTC 日付の集約キー形式", () => {
  const { alertWindowKey } = createBotAlerts({ sendTelegramMessage: async () => {} });
  assert.equal(alertWindowKey("gemini_limit", new Date("2026-10-25T23:59:59.999Z")), "gemini_limit:2026-10-25");
  assert.equal(alertWindowKey("configuration", new Date("2026-01-01T00:00:00.000Z")), "configuration:2026-01-01");
  assert.match(alertWindowKey("processing_failure"), /^processing_failure:\d{4}-\d{2}-\d{2}$/);
});

test("alertText: カテゴリ別文言と未知カテゴリのフォールバック", () => {
  const { alertText } = createBotAlerts({ sendTelegramMessage: async () => {} });
  assert.equal(alertText({ category: "gemini_limit", occurrences: 1 }), TEXTS.gemini_limit);
  assert.equal(alertText({ category: "configuration", occurrences: 1 }), TEXTS.configuration);
  assert.equal(alertText({ category: "processing_failure", occurrences: 1 }), TEXTS.processing_failure);
  assert.equal(alertText({ category: "unknown_category", occurrences: 1 }), TEXTS.processing_failure);
});

test("alertText: occurrences > 1 のときだけ集約注記が付く", () => {
  const { alertText } = createBotAlerts({ sendTelegramMessage: async () => {} });
  assert.equal(alertText({ category: "gemini_limit", occurrences: 1 }), TEXTS.gemini_limit);
  assert.equal(alertText({ category: "gemini_limit", occurrences: 3 }), `${TEXTS.gemini_limit}（同種の事象 3 件をまとめて通知）`);
});

test("enqueueBotAlert: env.DB がなければ no-op", async () => {
  const { enqueueBotAlert } = createBotAlerts({ sendTelegramMessage: async () => {} });
  await enqueueBotAlert({}, "gemini_limit");
  await enqueueBotAlert({ DB: null }, "configuration");
});

test("enqueueBotAlert: 既知カテゴリを保持し、INSERT の SQL 形と bind 順を固定する", async () => {
  const fake = createFakeDb();
  const { enqueueBotAlert, alertWindowKey } = createBotAlerts({ sendTelegramMessage: async () => {} });
  await enqueueBotAlert({ DB: fake.DB }, "configuration");
  assert.equal(fake.calls.length, 1);
  const { sql, args } = fake.calls[0];
  assert.ok(sql.includes("INSERT INTO bot_alerts"));
  assert.ok(sql.includes("ON CONFLICT(alert_key) DO UPDATE SET last_seen_at = excluded.last_seen_at, occurrences = bot_alerts.occurrences + 1"));
  assert.equal(args[0], alertWindowKey("configuration", new Date(args[2])));
  assert.equal(args[1], "configuration");
  assert.equal(args[2], args[3]);
  assert.equal(args[3], args[4]);
  const row = fake.rows.get(args[0]);
  assert.equal(row.status, "pending");
  assert.equal(row.occurrences, 1);
  assert.equal(row.send_attempts, 0);
});

test("enqueueBotAlert: 未知カテゴリは processing_failure に正規化する", async () => {
  const fake = createFakeDb();
  const { enqueueBotAlert } = createBotAlerts({ sendTelegramMessage: async () => {} });
  await enqueueBotAlert({ DB: fake.DB }, "something_else");
  assert.equal(fake.calls[0].args[1], "processing_failure");
  assert.ok(fake.calls[0].args[0].startsWith("processing_failure:"));
});

test("enqueueBotAlert: 同一キーへの再投入は occurrences を加算し last_seen_at を進める", async () => {
  const fake = createFakeDb();
  const { enqueueBotAlert } = createBotAlerts({ sendTelegramMessage: async () => {} });
  const env = { DB: fake.DB };
  await enqueueBotAlert(env, "gemini_limit");
  await enqueueBotAlert(env, "gemini_limit");
  assert.equal(fake.rows.size, 1);
  const row = [...fake.rows.values()][0];
  assert.equal(row.occurrences, 2);
  assert.ok(row.last_seen_at >= row.first_seen_at);
  assert.equal(row.status, "pending");
});

test("enqueueBotAlert: DB 例外を握りつぶし、安全化したログだけを出す", async () => {
  const fake = createFakeDb({ failOn: "INSERT INTO bot_alerts" });
  const { enqueueBotAlert } = createBotAlerts({ sendTelegramMessage: async () => {} });
  const captured = captureConsoleError();
  try {
    await enqueueBotAlert({ DB: fake.DB }, "gemini_limit");
  } finally {
    captured.restore();
  }
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "could not persist operational alert");
  assert.ok(String(captured.lines[0][1]).includes("operational_alert_persist_failed"));
});

test("flushBotAlerts: ガード (DB / chatId / トークン欠落) では送信しない", async () => {
  let sent = 0;
  const { flushBotAlerts } = createBotAlerts({ sendTelegramMessage: async () => { sent += 1; } });
  const fake = createFakeDb();
  seedAlert(fake.rows);
  await flushBotAlerts({}, "123", 3);
  await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "", 3);
  await flushBotAlerts({ DB: fake.DB }, "123", 3);
  assert.equal(sent, 0);
  assert.equal(fake.calls.length, 0);
});

test("flushBotAlerts: 期限到来の pending を claim して送り、sent 化と試行回数加算を行う", async () => {
  const fake = createFakeDb();
  const row = seedAlert(fake.rows, { send_attempts: 2 });
  const sentMessages = [];
  const { flushBotAlerts } = createBotAlerts({
    sendTelegramMessage: async (env, chatId, text) => { sentMessages.push({ env, chatId, text }); }
  });
  const env = { DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" };
  const before = Date.now();
  await flushBotAlerts(env, "123", 3);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].env, env);
  assert.equal(sentMessages[0].chatId, "123");
  assert.equal(sentMessages[0].text, TEXTS.gemini_limit);
  assert.equal(row.status, "sent");
  assert.equal(row.send_attempts, 3);
  assert.equal(row.claim_expires_at, null);
  assert.ok(Date.parse(row.sent_at) >= before - 1000);
  const claim = fake.calls.find((call) => call.sql.includes("SET status = 'sending'"));
  const claimMs = Date.parse(claim.args[0]) - Date.parse(claim.args[2]);
  assert.ok(claimMs > 100_000 && claimMs <= 120_000, `claim は約2分で失効する (実測 ${claimMs}ms)`);
});

test("flushBotAlerts: 期限未到来の pending と claim 有効中の sending は対象にしない", async () => {
  const fake = createFakeDb();
  seedAlert(fake.rows, { alert_key: "a:1", next_attempt_at: future() });
  seedAlert(fake.rows, { alert_key: "a:2", status: "sending", claim_expires_at: future() });
  let sent = 0;
  const { flushBotAlerts } = createBotAlerts({ sendTelegramMessage: async () => { sent += 1; } });
  await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  assert.equal(sent, 0);
});

test("flushBotAlerts: claim 失効済みの sending は再取得して送る", async () => {
  const fake = createFakeDb();
  const row = seedAlert(fake.rows, { status: "sending", claim_expires_at: past() });
  let sent = 0;
  const { flushBotAlerts } = createBotAlerts({ sendTelegramMessage: async () => { sent += 1; } });
  await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  assert.equal(sent, 1);
  assert.equal(row.status, "sent");
});

test("flushBotAlerts: first_seen_at の先着順に処理し、limit を 1–5 にクランプする", async () => {
  const fake = createFakeDb();
  for (let i = 0; i < 7; i += 1) {
    seedAlert(fake.rows, { alert_key: `k:${i}`, first_seen_at: past(600_000 - i * 1000) });
  }
  let sent = 0;
  const { flushBotAlerts } = createBotAlerts({ sendTelegramMessage: async () => { sent += 1; } });
  const env = { DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" };
  await flushBotAlerts(env, "123", 100);
  assert.equal(sent, 5);
  const select = fake.calls.find((call) => call.sql.includes("SELECT alert_key"));
  assert.equal(select.args[2], 5);
  await flushBotAlerts(env, "123", 0);
  assert.equal(sent, 6);
  const selects = fake.calls.filter((call) => call.sql.includes("SELECT alert_key"));
  assert.equal(selects[1].args[2], 1);
});

test("flushBotAlerts: claim が取れなかった行はスキップし、送信も状態変更もしない", async () => {
  const fake = createFakeDb();
  const row = seedAlert(fake.rows);
  const sentMessages = [];
  const { flushBotAlerts } = createBotAlerts({
    sendTelegramMessage: async () => { sentMessages.push(1); }
  });
  // 取得後に他者が claim した状況を再現する: claim の UPDATE だけ changes=0 にする。
  const originalPrepare = fake.DB.prepare;
  fake.DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        if (!sql.includes("SET status = 'sending'")) return bound;
        return { ...bound, run: async () => ({ meta: { changes: 0 } }) };
      }
    };
  };
  await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  assert.equal(sentMessages.length, 0);
  assert.equal(row.status, "pending");
});

test("flushBotAlerts: 送信失敗時は試行回数を増やし、指数バックオフで pending に戻す", async () => {
  const fake = createFakeDb();
  const row = seedAlert(fake.rows, { send_attempts: 0 });
  const { flushBotAlerts } = createBotAlerts({
    sendTelegramMessage: async () => { throw new Error("telegram down"); }
  });
  const before = Date.now();
  await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  assert.equal(row.status, "pending");
  assert.equal(row.send_attempts, 1);
  assert.equal(row.claim_expires_at, null);
  const retryInMs = Date.parse(row.next_attempt_at) - before;
  assert.ok(retryInMs > 4 * 60_000 && retryInMs <= 5 * 60_000 + 5_000, `初回は約5分後に再試行 (実測 ${retryInMs}ms)`);
});

test("flushBotAlerts: バックオフは 5分→10分と伸び、試行上限10・24時間で頭打ちになる", async () => {
  const fake = createFakeDb();
  const row = seedAlert(fake.rows, { send_attempts: 1 });
  const { flushBotAlerts } = createBotAlerts({
    sendTelegramMessage: async () => { throw new Error("telegram down"); }
  });
  const env = { DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" };
  let before = Date.now();
  await flushBotAlerts(env, "123", 3);
  assert.equal(row.send_attempts, 2);
  const secondRetryMs = Date.parse(row.next_attempt_at) - before;
  assert.ok(secondRetryMs > 9 * 60_000 && secondRetryMs <= 10 * 60_000 + 5_000, `2回目は約10分後 (実測 ${secondRetryMs}ms)`);

  row.status = "sending";
  row.claim_expires_at = past();
  row.send_attempts = 15;
  before = Date.now();
  await flushBotAlerts(env, "123", 3);
  assert.equal(row.send_attempts, 10);
  const cappedRetryMs = Date.parse(row.next_attempt_at) - before;
  assert.ok(cappedRetryMs > 23 * 3_600_000 && cappedRetryMs <= 24 * 3_600_000 + 5_000, `上限では約24時間後 (実測 ${cappedRetryMs}ms)`);
});

test("flushBotAlerts: 読み取り失敗時は静かに戻り、送信しない", async () => {
  const fake = createFakeDb({ failOn: "SELECT alert_key" });
  seedAlert(fake.rows);
  let sent = 0;
  const { flushBotAlerts } = createBotAlerts({ sendTelegramMessage: async () => { sent += 1; } });
  const captured = captureConsoleError();
  try {
    await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  } finally {
    captured.restore();
  }
  assert.equal(sent, 0);
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "could not read operational alerts");
});

test("flushBotAlerts: 再スケジュール失敗を握りつぶし、残りの処理を止めない", async () => {
  const fake = createFakeDb({ failOn: "SET status = 'pending'" });
  seedAlert(fake.rows, { alert_key: "k:1", first_seen_at: past(300_000) });
  const second = seedAlert(fake.rows, { alert_key: "k:2", first_seen_at: past(200_000) });
  const attempted = [];
  const { flushBotAlerts } = createBotAlerts({
    sendTelegramMessage: async (env, chatId, text) => {
      attempted.push(text);
      if (attempted.length === 1) throw new Error("telegram down");
    }
  });
  const captured = captureConsoleError();
  try {
    await flushBotAlerts({ DB: fake.DB, TELEGRAM_BOT_TOKEN: "token" }, "123", 3);
  } finally {
    captured.restore();
  }
  assert.equal(attempted.length, 2);
  assert.equal(second.status, "sent");
  assert.ok(captured.lines.some((line) => line[0] === "could not reschedule operational alert"));
});
