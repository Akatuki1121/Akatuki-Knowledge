import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  readVaultOrganizationCursor,
  readVaultOrganizationStats,
  scanVaultOrganizationInbox,
  vaultOrganizationSeenKey,
} from "../src/vault-organization-store.mjs";

// 偽の D1 (node:sqlite) で巡回を確かめる。巡回はノートを変更せず、
// app_meta へだけ書く。

function createFakeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  sqlite.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT, content_hash TEXT, sync_uuid TEXT, updated_at TEXT NOT NULL, deleted_at TEXT)`);
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

function insertNote(db, { path, title, content, updatedAt = OLD, syncUuid = null, contentHash = null }) {
  sequence++;
  const id = path;
  const hash = contentHash ?? createHash("sha256").update(content ?? "").digest("hex");
  db.sqlite.prepare("INSERT INTO notes (id, path, title, content, content_hash, sync_uuid, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
    .run(id, path, title, content, hash, syncUuid ?? "uuid-" + sequence, updatedAt);
  return { id, path, title, content, contentHash: hash, syncUuid: syncUuid ?? "uuid-" + sequence };
}

function noteRows(db) {
  return db.sqlite.prepare("SELECT id, path, title, content, content_hash, sync_uuid, updated_at FROM notes ORDER BY id").all();
}

test("scan classifies by rules, AI, and undecided; marks seen; never mutates notes", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  insertNote(db, {
    path: "Notes/Inbox/原ゼミちゃん企画発表後.md", title: "原ゼミちゃん企画発表後",
    content: "企画発表が終わった。次は試作を進める。",
  });
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル",
    content: "短いメモ。",
  });
  const before = noteRows(db);
  let aiCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async ({ title }) => {
      aiCalls++;
      if (title.includes("原ゼミ")) {
        return { outcome: "decided", targetPath: "Notes/原ゼミ最終課題", confidence: 0.7, reason: "企画発表", neurons: 11 };
      }
      return { outcome: "undecided", confidence: 0.3, neurons: 9 };
    },
  });
  assert.equal(result.scanned, 3);
  assert.equal(result.ruleDecided, 1);
  assert.equal(result.aiCalled, 2);
  assert.equal(result.aiDecided, 1);
  assert.equal(result.undecided, 1);
  assert.equal(result.claudePending, 1);
  assert.equal(result.aiNeurons, 20);
  assert.equal(aiCalls, 2);
  assert.deepEqual(noteRows(db), before, "scan must not mutate notes");
  const stats = await readVaultOrganizationStats(db, "2026-11-15");
  assert.equal(stats.rule_decided, 1);
  assert.equal(stats.ai_called, 2);
  assert.equal(stats.confidence_buckets["0.7"], 1);
  assert.equal(stats.confidence_buckets["0.3"], 1);
  assert.equal(stats.runs, 1);
  assert.equal(await readVaultOrganizationCursor(db), null, "cursor wraps after a full pass");
});

test("already-seen notes are skipped on a wrap-around rescan", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。",
  });
  let aiCalls = 0;
  const options = {
    nowMs: NOW,
    classifyWithAi: async () => { aiCalls++; return { outcome: "undecided", confidence: null, neurons: 5 }; },
  };
  await scanVaultOrganizationInbox(db, options);
  const second = await scanVaultOrganizationInbox(db, options);
  assert.equal(second.scanned, 1);
  assert.equal(second.aiCalled, 0);
  assert.equal(second.undecided, 0);
  assert.equal(aiCalls, 1);
});

test("changed content is reclassified (the seen key follows the content hash)", async () => {
  const db = createFakeDb();
  const note = insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。",
  });
  let aiCalls = 0;
  const options = {
    nowMs: NOW,
    classifyWithAi: async () => { aiCalls++; return { outcome: "undecided", confidence: null, neurons: 5 }; },
  };
  await scanVaultOrganizationInbox(db, options);
  const newContent = "書き換えたメモ。";
  const newHash = createHash("sha256").update(newContent).digest("hex");
  db.sqlite.prepare("UPDATE notes SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?")
    .run(newContent, newHash, "2026-11-15 07:00:00", note.id);
  const second = await scanVaultOrganizationInbox(db, options);
  assert.equal(second.aiCalled, 1);
  assert.equal(aiCalls, 2);
  const seen = db.sqlite.prepare("SELECT key FROM app_meta WHERE key = ?").get(await vaultOrganizationSeenKey(note.syncUuid, newHash));
  assert.ok(seen, "the new content hash must be marked seen");
});

test("a note inside the grace period defers and stops the cursor before it", async () => {
  const db = createFakeDb();
  const first = insertNote(db, {
    path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化",
    content: "演習の続き。キューブマップの一部をムービー化する。",
  });
  insertNote(db, {
    path: "Notes/Inbox/書きかけ.md", title: "書きかけ",
    content: "まだ書いている途中。", updatedAt: "2026-11-15 11:30:00",
  });
  const result = await scanVaultOrganizationInbox(db, { nowMs: NOW, classifyWithAi: null });
  assert.equal(result.ruleDecided, 1);
  assert.equal(result.deferred, 1);
  const cursor = await readVaultOrganizationCursor(db);
  assert.deepEqual(cursor, { updatedAt: first.updatedAt ?? "2026-11-15 06:00:00", id: first.id });
  // 猶予が過ぎれば次回に分類される。
  const later = await scanVaultOrganizationInbox(db, {
    nowMs: Date.parse("2026-11-15T14:00:00Z"),
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
  });
  assert.equal(later.deferred, 0);
  assert.equal(later.aiCalled, 1);
});

test("excluded notes never reach rules or AI", async () => {
  const db = createFakeDb();
  insertNote(db, {
    path: "Notes/Inbox/Akatuki-Knowledge E2E 発行用の環境変数.md", title: "Akatuki-Knowledge E2E 発行用の環境変数",
    content: "秘密の値。",
  });
  let aiCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => { aiCalls++; return { outcome: "undecided", confidence: null, neurons: 5 }; },
  });
  assert.equal(result.excluded, 1);
  assert.equal(result.aiCalled, 0);
  assert.equal(aiCalls, 0);
});

test("an unfetchable note is not read as empty and blocks the cursor", async () => {
  const db = createFakeDb();
  db.sqlite.prepare("INSERT INTO notes (id, path, title, content, content_hash, sync_uuid, updated_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)")
    .run("Notes/Inbox/壊れた行.md", "Notes/Inbox/壊れた行.md", "壊れた行", "a".repeat(64), "uuid-broken", OLD);
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。", updatedAt: "2026-11-15 07:00:00",
  });
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
  });
  assert.equal(result.failed, 1);
  assert.equal(result.scanned, 1, "the scan stops at the unfetchable note");
  assert.equal(await readVaultOrganizationCursor(db), null, "cursor must not advance past it");
});

test("the scan limit advances the cursor and the next run continues", async () => {
  const db = createFakeDb();
  for (let i = 0; i < 12; i++) {
    insertNote(db, {
      path: `Notes/Inbox/メモ${i}.md`, title: `メモ${i}`, content: "短いメモ。",
      updatedAt: `2026-11-15 05:${String(i).padStart(2, "0")}:00`,
    });
  }
  const options = {
    nowMs: NOW,
    classifyWithAi: async () => ({ outcome: "undecided", confidence: null, neurons: 5 }),
  };
  const first = await scanVaultOrganizationInbox(db, options);
  assert.equal(first.scanned, 10);
  assert.equal(first.hasMore, true);
  assert.ok(await readVaultOrganizationCursor(db), "cursor advances on a full page");
  const second = await scanVaultOrganizationInbox(db, options);
  assert.equal(second.scanned, 2);
  assert.equal(second.hasMore, false);
  assert.equal(await readVaultOrganizationCursor(db), null, "cursor wraps at the end of the list");
});

test("the daily AI cap stops further AI calls", async () => {
  const db = createFakeDb();
  db.sqlite.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)")
    .run("vault_organization_stats:2026-11-15", JSON.stringify({ ai_called: 30 }), new Date(NOW).toISOString());
  insertNote(db, {
    path: "Notes/Inbox/無題のファイル.md", title: "無題のファイル", content: "短いメモ。",
  });
  let aiCalls = 0;
  const result = await scanVaultOrganizationInbox(db, {
    nowMs: NOW,
    classifyWithAi: async () => { aiCalls++; return { outcome: "undecided", confidence: null, neurons: 5 }; },
  });
  assert.equal(result.aiCalled, 0);
  assert.equal(aiCalls, 0);
  assert.equal(result.undecided, 1);
});

console.log("Vault organization scan tests passed.");
