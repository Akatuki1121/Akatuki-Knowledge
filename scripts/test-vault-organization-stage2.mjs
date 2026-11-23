import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  listVaultOrganizationRecords,
  readVaultOrganizationStats,
  scanVaultOrganizationInbox,
} from "../src/vault-organization-store.mjs";

// 段階2の巡回を偽の D1 (node:sqlite) で確かめる。記録テーブルは
// マイグレーションの実物 (migrations/0020) を適用して用意する。
// 実行 (移動・整形) は注入関数で、呼び出しの引き数と回数を見る。

const MIGRATION_SQL = await readFile(
  new URL("../migrations/0020_vault_organization_records.sql", import.meta.url),
  "utf8",
);

function createFakeDb({ withRecordsTable = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  sqlite.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT, content_hash TEXT, sync_uuid TEXT, updated_at TEXT NOT NULL, deleted_at TEXT)`);
  if (withRecordsTable) sqlite.exec(MIGRATION_SQL);
  return {
    sqlite,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values) ?? null; },
        all() { return { results: sqlite.prepare(sql).all(...values) }; },
        run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
}

const NOW = Date.parse("2026-11-15T12:00:00Z");
const OLD = "2026-11-15 06:00:00"; // 猶予 (2時間) を過ぎている
let sequence = 0;

function insertNote(db, { path, title, content, updatedAt = OLD, syncUuid = null }) {
  sequence++;
  const hash = createHash("sha256").update(content ?? "").digest("hex");
  const uuid = syncUuid ?? "uuid-" + sequence;
  db.sqlite.prepare("INSERT INTO notes (id, path, title, content, content_hash, sync_uuid, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
    .run(path, path, title, content, hash, uuid, updatedAt);
  return { id: path, path, title, content, contentHash: hash, syncUuid: uuid };
}

function recordRows(db) {
  return db.sqlite.prepare("SELECT * FROM vault_organization_records ORDER BY record_id").all();
}

test("classifications are written as per-note records when the table exists", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。",
  });
  insertNote(db, {
    path: "Notes/Inbox/Akatuki-Knowledge E2E 発行用の環境変数.md", title: "Akatuki-Knowledge E2E 発行用の環境変数",
    content: "秘密の値。",
  });
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: 0.3, neurons: 9 }),
  });
  assert.equal(result.recordsAvailable, true);
  const rows = recordRows(db);
  assert.equal(rows.length, 3);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const rule = byPath.get("Notes/Inbox/キューブマップ 一部 ムービー化.md");
  assert.equal(rule.action, "classify");
  assert.equal(rule.basis_kind, "rule");
  assert.equal(rule.stage, 1);
  assert.equal(rule.target_path, "Notes/プログラムワークショップIV");
  assert.equal(rule.outcome, "recorded");
  assert.equal(rule.content_hash_before, rule.content_hash_after);
  assert.deepEqual(JSON.parse(rule.basis_detail), { ruleId: "K3" });
  const undecided = byPath.get("Notes/Inbox/無題のファイル.md");
  assert.equal(undecided.basis_kind, "claude_pending");
  assert.equal(undecided.outcome, "recorded");
  const excluded = byPath.get("Notes/Inbox/Akatuki-Knowledge E2E 発行用の環境変数.md");
  assert.equal(excluded.basis_kind, "excluded");
  assert.equal(excluded.stage, 0);
});

test("a note inside the grace period is recorded as deferred", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/書きかけ.md", title: "書きかけ", content: "まだ書いている途中。",
    updatedAt: "2026-11-15 11:30:00",
  });
  const result = await scanVaultOrganizationInbox(db, { nowMs: NOW, classifyWithAi: null });
  assert.equal(result.deferred, 1);
  const rows = recordRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].basis_kind, "grace");
  assert.equal(rows[0].outcome, "deferred");
});

test("without the records table the scan classifies as in stage 1 and never executes", async () => {
  const db = createFakeDb({ withRecordsTable: false });
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  let moveCalls = 0;
  let formatCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: null,
    executeMove: async () => { moveCalls++; return { outcome: "moved", contentHash: "x" }; },
    executeFormat: async () => { formatCalls++; return { outcome: "formatted", contentHashAfter: "y" }; },
  });
  assert.equal(result.recordsAvailable, false);
  assert.equal(result.ruleDecided, 1);
  assert.equal(result.moved, 0);
  assert.equal(moveCalls, 0, "execution must not run while records cannot be written");
  assert.equal(formatCalls, 0);
  assert.equal(await listVaultOrganizationRecords(db, {}), null);
});

test("a rule-decided stage-1 note is moved through the executor and recorded", async () => {
  const db = createFakeDb();
  const note = insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  const calls = [];
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: null,
    executeMove: async (input) => {
      calls.push(input);
      return { outcome: "moved", contentHash: note.contentHash };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].noteId, note.id);
  assert.equal(calls[0].sourcePath, note.path);
  assert.equal(calls[0].targetPath, "Notes/プログラムワークショップIV/キューブマップ 一部 ムービー化.md");
  assert.equal(calls[0].expectedContentHash, note.contentHash);
  assert.equal(calls[0].syncUuid, note.syncUuid);
  assert.equal(result.moved, 1);
  assert.equal(result.executionFailed, 0);
  const moveRecord = recordRows(db).find((row) => row.action === "move");
  assert.ok(moveRecord, "the move must be recorded");
  assert.equal(moveRecord.outcome, "recorded");
  assert.equal(moveRecord.basis_kind, "rule");
  assert.equal(moveRecord.target_path, "Notes/プログラムワークショップIV/キューブマップ 一部 ムービー化.md");
  assert.equal(moveRecord.content_hash_before, note.contentHash);
  assert.equal(moveRecord.content_hash_after, note.contentHash);
  assert.deepEqual(JSON.parse(moveRecord.detail_json), { error: null, identityVerified: true });
  const stats = await readVaultOrganizationStats(db, "2026-11-15");
  assert.equal(stats.moved, 1);
});

test("an AI-decided stage-1 note is never executed", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/原ゼミちゃん企画発表後.md", title: "原ゼミちゃん企画発表後",
    content: "企画発表が終わった。次は試作を進める。",
  });
  let moveCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "decided", targetPath: "Notes/原ゼミ最終課題", confidence: 0.7, reason: "企画発表", neurons: 11 }),
    executeMove: async () => { moveCalls++; return { outcome: "moved", contentHash: "x" }; },
  });
  assert.equal(result.aiDecided, 1);
  assert.equal(moveCalls, 0);
  assert.equal(recordRows(db).filter((row) => row.action === "move").length, 0);
  const classify = recordRows(db).find((row) => row.action === "classify");
  assert.equal(classify.basis_kind, "workers_ai");
  assert.equal(classify.confidence, 0.7);
});

test("a refused move is recorded as failed and counted, with no fallback", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: null,
    executeMove: async () => ({ outcome: "failed", error: "destination_note_exists" }),
  });
  assert.equal(result.moved, 0);
  assert.equal(result.executionFailed, 1);
  const moveRecord = recordRows(db).find((row) => row.action === "move");
  assert.equal(moveRecord.outcome, "failed");
  assert.deepEqual(JSON.parse(moveRecord.detail_json), { error: "destination_note_exists", identityVerified: false });
  const stats = await readVaultOrganizationStats(db, "2026-11-15");
  assert.equal(stats.execution_failed, 1);
});

test("a K4 web-clip note is formatted with whitespace normalization only", async () => {
  const db = createFakeDb();
  const messy = "記事の本文です。  \n次の行。\n\n\n\n\n末尾の行。\n\n\n";
  const note = insertNote(db, {
    path: "Notes/Inbox/スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台 ライフハッカー・ジャパン.md",
    title: "スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台 ライフハッカー・ジャパン",
    content: messy,
  });
  const calls = [];
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
    executeFormat: async (input) => {
      calls.push(input);
      return { outcome: "formatted", contentHashAfter: createHash("sha256").update(input.content).digest("hex") };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].noteId, note.id);
  assert.equal(calls[0].content, "記事の本文です。\n次の行。\n\n末尾の行。\n");
  assert.equal(calls[0].expectedContentHash, note.contentHash);
  assert.equal(result.formatted, 1);
  const formatRecord = recordRows(db).find((row) => row.action === "format");
  assert.ok(formatRecord, "the format must be recorded");
  assert.equal(formatRecord.stage, 2);
  assert.equal(formatRecord.basis_kind, "rule");
  assert.equal(formatRecord.outcome, "recorded");
  assert.equal(formatRecord.content_hash_before, note.contentHash);
  assert.equal(formatRecord.content_hash_after, createHash("sha256").update(calls[0].content).digest("hex"));
});

test("an already-normalized K4 note is not formatted", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台 ライフハッカー・ジャパン.md",
    title: "スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台 ライフハッカー・ジャパン",
    content: "記事の本文です。\n次の行。\n",
  });
  let formatCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
    executeFormat: async () => { formatCalls++; return { outcome: "formatted", contentHashAfter: "y" }; },
  });
  assert.equal(formatCalls, 0);
  assert.equal(result.formatted, 0);
});

test("when record inserts fail mid-run the scan falls back to classify-only", async () => {
  const db = createFakeDb();
  db.sqlite.exec(`CREATE TRIGGER reject_organization_records BEFORE INSERT ON vault_organization_records
    BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  let moveCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: null,
    executeMove: async () => { moveCalls++; return { outcome: "moved", contentHash: "x" }; },
  });
  assert.equal(result.ruleDecided, 1);
  assert.equal(moveCalls, 0, "execution requires the classification record to be written first");
  assert.equal(result.moved, 0);
});

test("records can be listed with period and basis filters", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。",
  });
  await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
    executeMove: async () => ({ outcome: "moved", contentHash: "h" }),
  });
  const all = await listVaultOrganizationRecords(db, {});
  assert.equal(all.length, 3);
  const rules = await listVaultOrganizationRecords(db, { basisKind: "rule" });
  assert.equal(rules.length, 2);
  assert.ok(rules.every((row) => row.basis_kind === "rule"));
  const moves = await listVaultOrganizationRecords(db, { action: "move" });
  assert.equal(moves.length, 1);
  const future = await listVaultOrganizationRecords(db, { since: "2026-11-16T00:00:00.000Z" });
  assert.equal(future.length, 0);
  const past = await listVaultOrganizationRecords(db, { until: "2026-11-14T00:00:00.000Z" });
  assert.equal(past.length, 0);
  assert.deepEqual(all[0].detail_json, {}, "detail_json is parsed for the reader");
});

console.log("Vault organization stage-2 scan tests passed.");
