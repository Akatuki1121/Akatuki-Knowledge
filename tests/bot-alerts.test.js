// src/bot-alerts.mjs のモジュール契約テスト。
// Telegram ボット廃止に伴い、運用アラートは bot_alerts テーブルへの保存と
// Telegram 送信をやめ、Workers Logs への構造化ログ出力のみになった。
// 壊れても利用者には見えない経路なので、ログの形と「配送に戻らない」ことを固定する。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBotAlerts } from "../src/bot-alerts.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
// enqueueBotAlert は organize runner へも注入されるため、実体化がそれより前にあることも見る。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./bot-alerts.mjs"'), "the Worker entry point must import the bot alerts module");
assert.ok(workerSource.includes("createBotAlerts()"), "the Worker entry point must build bot alerts through the factory without a Telegram sender");
assert.ok(!workerSource.includes("createBotAlerts({ sendTelegramMessage })"), "the Worker entry point must not inject a Telegram sender into bot alerts");
assert.ok(
  workerSource.indexOf("createBotAlerts()") < workerSource.indexOf("createOrganizeRunner({"),
  "bot alerts must be built before the organize runner consumes enqueueBotAlert"
);

const moduleSource = await readFile(new URL("../src/bot-alerts.mjs", import.meta.url), "utf8");
assert.ok(!moduleSource.includes("sendTelegramMessage"), "bot alerts must not depend on a Telegram sender");
assert.ok(!moduleSource.includes("INSERT INTO bot_alerts"), "bot alerts must not persist alerts to D1");
assert.ok(!moduleSource.includes("flushBotAlerts"), "the Telegram flush path must stay removed");

function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  return { lines, restore: () => { console.error = original; } };
}

test("alertWindowKey: カテゴリと UTC 日付の集約キー形式", () => {
  const { alertWindowKey } = createBotAlerts();
  assert.equal(alertWindowKey("gemini_limit", new Date("2026-10-25T23:59:59.999Z")), "gemini_limit:2026-10-25");
  assert.equal(alertWindowKey("configuration", new Date("2026-01-01T00:00:00.000Z")), "configuration:2026-01-01");
  assert.match(alertWindowKey("processing_failure"), /^processing_failure:\d{4}-\d{2}-\d{2}$/);
});

test("createBotAlerts: 配送用 API (flushBotAlerts / alertText) を公開しない", () => {
  const api = createBotAlerts();
  assert.equal(typeof api.enqueueBotAlert, "function");
  assert.equal(api.flushBotAlerts, undefined);
  assert.equal(api.alertText, undefined);
});

test("enqueueBotAlert: 既知カテゴリを構造化ログとして1行だけ出す", async () => {
  const { enqueueBotAlert } = createBotAlerts();
  const captured = captureConsoleError();
  try {
    await enqueueBotAlert({}, "gemini_limit");
  } finally {
    captured.restore();
  }
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "operational alert");
  const payload = JSON.parse(captured.lines[0][1]);
  assert.equal(payload.event, "operational_alert");
  assert.equal(payload.category, "gemini_limit");
  assert.match(payload.alertKey, /^gemini_limit:\d{4}-\d{2}-\d{2}$/);
});

test("enqueueBotAlert: 未知カテゴリは processing_failure に正規化する", async () => {
  const { enqueueBotAlert } = createBotAlerts();
  const captured = captureConsoleError();
  try {
    await enqueueBotAlert({}, "something_else");
  } finally {
    captured.restore();
  }
  const payload = JSON.parse(captured.lines[0][1]);
  assert.equal(payload.category, "processing_failure");
  assert.ok(payload.alertKey.startsWith("processing_failure:"));
});

test("enqueueBotAlert: DB に一切触れない (壊れた DB でも例外なくログだけ出す)", async () => {
  const { enqueueBotAlert } = createBotAlerts();
  const hostileDb = { prepare() { throw new Error("must not be called"); } };
  const captured = captureConsoleError();
  try {
    await enqueueBotAlert({ DB: hostileDb }, "configuration");
    await enqueueBotAlert({}, "configuration");
    await enqueueBotAlert({ DB: null }, "gemini_limit");
  } finally {
    captured.restore();
  }
  assert.equal(captured.lines.length, 3);
});

test("enqueueBotAlert: ログに本文や自由文字列を含めない", async () => {
  const { enqueueBotAlert } = createBotAlerts();
  const captured = captureConsoleError();
  try {
    await enqueueBotAlert({}, "processing_failure");
  } finally {
    captured.restore();
  }
  const line = captured.lines[0].join(" ");
  assert.ok(!line.includes("Error"), "alert logs must not embed error objects");
  assert.deepEqual(Object.keys(JSON.parse(captured.lines[0][1])).sort(), ["alertKey", "category", "event"]);
});
