// Issue #86: src/ai-permission.mjs のモジュール契約テスト。
// 一括 AI 許可 (Issue #61) の関数群を index.js から分離したため、文字列抽出ではなく
// モジュールの振る舞いで検証する (tests/gemini-client.test.js と同じ方針)。
// inspectWholeContent / hasSensitiveCategory は ai-send-guard の意味論を模したスタブを注入する
// (ガード自体の検証は tests/ai-send-guard.test.js が担当)。
// 2026-10-25 の方針変更で、実ガードは機微語 (診断など) を findings に出さなくなった。
// そのため既定スタブもカテゴリを返さない。hold 経路はモジュール契約として残るため、
// カテゴリを返すスタブで別途検証する (下部の contract test)。
import test from "node:test";
import assert from "node:assert/strict";
import { createBulkAiPermission } from "../src/ai-permission.mjs";

const inspectWholeContent = (content) => {
  return { ok: true, findings: [], credentials: String(content).includes("SECRET-CREDENTIAL") };
};
const hasSensitiveCategory = (findings) => (findings || []).some((f) => ["health", "financial", "location"].includes(f));

const bulk = createBulkAiPermission({ inspectWholeContent, hasSensitiveCategory });

// --- 最小のインメモリ D1 フェイク (ai-permission が使う SQL 形だけを実装) ---
class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() {
    if (this.sql.startsWith("SELECT id, content, content_hash, ai_allowed FROM notes WHERE deleted_at IS NULL AND path IS NOT NULL AND id IN")) {
      const wanted = new Set(this.args.map(String));
      return { results: this.db.notes.filter((n) => wanted.has(String(n.id))) };
    }
    if (this.sql.startsWith("SELECT id, content, content_hash, ai_allowed FROM notes")) {
      return { results: this.db.notes.slice() };
    }
    throw new Error("unexpected all(): " + this.sql);
  }
  async first() {
    if (this.sql.startsWith("SELECT candidates_json, expires_at, status FROM bot_ai_permission_previews")) {
      return this.db.previews.get(this.args[0]) || null;
    }
    if (this.sql.startsWith("SELECT content, created_at FROM telegram_messages")) {
      return this.db.assistantMessages.get(this.args[0]) || null;
    }
    throw new Error("unexpected first(): " + this.sql);
  }
  async run() {
    if (this.sql.startsWith("DELETE FROM bot_ai_permission_previews")) {
      const existed = this.db.previews.delete(this.args[0]);
      return { meta: { changes: existed ? 1 : 0 } };
    }
    if (this.sql.startsWith("INSERT INTO bot_ai_permission_previews")) {
      const [chatId, candidatesJson, createdAt, expiresAt] = this.args;
      this.db.previews.set(chatId, { candidates_json: candidatesJson, created_at: createdAt, expires_at: expiresAt, status: "pending" });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE notes SET")) { return { meta: { changes: 0 } }; }
    throw new Error("unexpected run(): " + this.sql);
  }
  applyUpdate() {
    const note = this.db.notes.find((n) => String(n.id) === String(this.args[0]));
    if (!note) return 0;
    // 本番 SQL の CAS 条件 (content_hash IS ? AND content = ?) を再現する
    const contentHash = this.args[1];
    const content = this.args[2];
    if ((note.content_hash ?? null) !== contentHash || note.content !== content) return 0;
    if (this.sql.includes("SET ai_allowed = 1")) {
      if (note.ai_allowed !== 0) return 0;
      note.ai_allowed = 1; note.sensitivity = "user-approved"; note.review_state = "ready";
      return 1;
    }
    if (this.sql.includes("SET ai_allowed = 0")) {
      if (note.ai_allowed !== 1) return 0;
      note.ai_allowed = 0; note.sensitivity = "credentials"; note.review_state = "blocked_credentials";
      return 1;
    }
    if (this.sql.includes("SET sensitivity = 'sensitive'")) {
      note.sensitivity = "sensitive"; note.review_state = "ready";
      return 1;
    }
    return 0;
  }
}
class FakeDB {
  constructor() { this.notes = []; this.previews = new Map(); this.assistantMessages = new Map(); }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) { return statements.map((s) => ({ meta: { changes: s.applyUpdate() } })); }
}

function seedDb() {
  const db = new FakeDB();
  db.notes = [
    { id: 1, content: "通常のノート", content_hash: "h1", ai_allowed: 0, sensitivity: null, review_state: null },
    { id: 2, content: "token: SECRET-CREDENTIAL を含む", content_hash: "h2", ai_allowed: 1, sensitivity: null, review_state: null },
    { id: 3, content: "診断の話", content_hash: "h3", ai_allowed: 0, sensitivity: null, review_state: null },
    { id: 4, content: "許可済みの通常ノート", content_hash: "h4", ai_allowed: 1, sensitivity: null, review_state: null }
  ];
  return db;
}

test("intent matchers accept only the exact bulk-permission phrases", () => {
  assert.equal(bulk.isBulkAiPermissionRequest("AI送信許可を一括確認して"), true);
  assert.equal(bulk.isBulkAiPermissionRequest("AI許可を安全に一括設定"), true);
  assert.equal(bulk.isBulkAiPermissionRequest("AI送信許可を一括確認してほしい"), false);
  assert.equal(bulk.isBulkAiPermissionApproval("AI送信許可を一括反映して"), true);
  assert.equal(bulk.isBulkAiPermissionApproval("AI送信許可を一括確認して"), false);
  assert.equal(bulk.isBulkAiPermissionRejection("AI送信許可の一括許可案を却下して"), true);
  assert.equal(bulk.isBulkAiPermissionRejection("AI送信許可を一括反映して"), false);
});

test("propose stores a pending preview and reports the scan counts", async () => {
  const db = seedDb();
  const reply = await bulk.proposeBulkAiPermission({ DB: db }, 123);
  assert.ok(reply.startsWith("AI送信許可の一括反映待ちです。"));
  assert.ok(reply.includes("対象ノート: 4件"));
  // 機微語 (診断) だけを含むノート3 は、方針変更後は許可候補になる。
  assert.ok(reply.includes("新たに許可できるノート: 2件"));
  assert.ok(reply.includes("認証情報を検出: 1件"));
  assert.ok(reply.includes("機微情報のため確認待ち: 0件"));
  assert.ok(reply.includes("既に許可済み（安全確認済み）: 1件"));
  const preview = db.previews.get(123);
  assert.ok(preview, "preview must be stored");
  const candidates = JSON.parse(preview.candidates_json);
  assert.deepEqual(candidates.map((c) => [c.id, c.action]), [["1", "allow"], ["3", "allow"], ["2", "revoke"]]);
  assert.ok(candidates.every((c) => /^[a-f0-9]{64}$/.test(c.hash)), "candidate hashes must be SHA-256 hex of the content");
});

test("apply flips only the previewed notes whose content still matches", async () => {
  const db = seedDb();
  const env = { DB: db };
  const proposal = await bulk.proposeBulkAiPermission(env, 123);
  db.assistantMessages.set(123, { content: proposal, created_at: new Date(Date.now() + 1000).toISOString() });
  const reply = await bulk.applyBulkAiPermission(env, 123);
  assert.ok(reply.startsWith("AI送信許可の一括反映が完了しました。"));
  assert.ok(reply.includes("新たに許可: 2件"));
  assert.ok(reply.includes("認証情報検出により許可解除: 1件"));
  assert.ok(reply.includes("機微情報ノートの安全処理へ移行: 0件"));
  const byId = Object.fromEntries(db.notes.map((n) => [n.id, n]));
  assert.equal(byId[1].ai_allowed, 1);
  assert.equal(byId[1].sensitivity, "user-approved");
  assert.equal(byId[2].ai_allowed, 0);
  assert.equal(byId[2].sensitivity, "credentials");
  // 機微語だけのノート3 も通常ノートと同じく許可される (方針変更)。
  assert.equal(byId[3].ai_allowed, 1);
  assert.equal(byId[3].sensitivity, "user-approved");
  assert.equal(byId[4].ai_allowed, 1);
  assert.equal(db.previews.has(123), false, "preview must be consumed");
});

// モジュール契約: 注入されたガードが機微カテゴリを返す場合に限り、hold 経路
// (許可せず sensitivity='sensitive' にする安全処理) が働く。現行ポリシーでは
// 実ガードがカテゴリを返さないため本番では発火しないが、ai-permission の
// 依存契約としては維持し、ここで担保する。
test("hold path still applies when the injected guard reports a sensitive category (module contract)", async () => {
  const sensitiveGuard = (content) => {
    const findings = [];
    if (String(content).includes("診断")) findings.push("health");
    return { ok: true, findings, credentials: String(content).includes("SECRET-CREDENTIAL") };
  };
  const bulkWithSensitiveGuard = createBulkAiPermission({ inspectWholeContent: sensitiveGuard, hasSensitiveCategory });
  const db = seedDb();
  const env = { DB: db };
  const proposal = await bulkWithSensitiveGuard.proposeBulkAiPermission(env, 123);
  assert.ok(proposal.includes("機微情報のため確認待ち: 1件"));
  db.assistantMessages.set(123, { content: proposal, created_at: new Date(Date.now() + 1000).toISOString() });
  const reply = await bulkWithSensitiveGuard.applyBulkAiPermission(env, 123);
  assert.ok(reply.includes("機微情報ノートの安全処理へ移行: 1件"));
  const byId = Object.fromEntries(db.notes.map((n) => [n.id, n]));
  assert.equal(byId[3].ai_allowed, 0, "held notes must not be allowed");
  assert.equal(byId[3].sensitivity, "sensitive");
});

test("apply skips notes whose content changed after the preview", async () => {
  const db = seedDb();
  const env = { DB: db };
  const proposal = await bulk.proposeBulkAiPermission(env, 123);
  db.notes[0].content = "確認後に書き換えられたノート";
  db.assistantMessages.set(123, { content: proposal, created_at: new Date(Date.now() + 1000).toISOString() });
  const reply = await bulk.applyBulkAiPermission(env, 123);
  assert.ok(reply.includes("内容変更・状態変化・競合で見送り: 1件"));
  assert.equal(db.notes[0].ai_allowed, 0, "changed note must not be approved");
});

test("apply without a fresh assistant confirmation is refused", async () => {
  const db = seedDb();
  const env = { DB: db };
  await bulk.proposeBulkAiPermission(env, 123);
  const reply = await bulk.applyBulkAiPermission(env, 123);
  assert.ok(reply.includes("直近の確認結果と一致しないため、反映を中止しました"));
  assert.equal(db.notes[0].ai_allowed, 0);
});

test("reject withdraws the pending preview exactly once", async () => {
  const db = seedDb();
  const env = { DB: db };
  await bulk.proposeBulkAiPermission(env, 123);
  const first = await bulk.rejectBulkAiPermission(env, 123);
  assert.ok(first.includes("取り下げました"));
  const second = await bulk.rejectBulkAiPermission(env, 123);
  assert.ok(second.includes("取り下げる一括許可案はありません"));
});
