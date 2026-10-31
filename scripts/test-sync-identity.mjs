import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSyncOutbox } from "../src/sync-outbox.mjs";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncNotes(request, env) {");
const marker = '__name(syncNotes, "syncNotes");';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "Could not extract syncNotes from the Worker bundle");
const syncNotesSource = source.slice(start, end);
const identityMigration = await readFile(new URL("../migrations/0015_yaos_file_identity_map.sql", import.meta.url), "utf8");
assert.match(identityMigration, /file_id TEXT PRIMARY KEY/);
assert.match(identityMigration, /sync_uuid TEXT NOT NULL UNIQUE/);
assert.match(identityMigration, /note_id TEXT NOT NULL UNIQUE/);
assert.match(identityMigration, /classification IN \('deferred', 'needs_review'\)/);

function readUuid(content) {
  const fm = String(content || "").slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm?.[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
}
function isValidSyncUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function makeDb(initialNotes = [], initialMappings = []) {
  const stats = { first: 0, all: 0, run: 0, batch: 0 };
  const notes = structuredClone(initialNotes);
  const mappings = structuredClone(initialMappings);
  const reviews = [];
  const revisions = [];
  const jobs = [];
  const db = {
    notes, mappings, reviews, revisions, jobs, stats,
    async batch(statements) {
      stats.batch++;
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return this; },
        async first() {
          stats.first++;
          if (sql.includes("FROM note_archive_events")) return { archive_event_id: 1, previous_ai_allowed: 1, previous_review_state: "ready" };
          if (sql.includes("FROM note_revisions")) return revisions.length ? { content: revisions.at(-1).content } : null;
          if (sql.includes("FROM yaos_file_identity_map WHERE last_path = ? AND file_id <> ?")) return mappings.find((m) => m.last_path === values[0] && m.file_id !== values[1]) ?? null;
          if (sql.includes("FROM yaos_file_identity_map")) {
            const rows = await this.all();
            return rows.results[0] ?? null;
          }
          if (sql.includes("FROM notes WHERE path = ?")) return notes.find((n) => n.path === values[0]) ?? null;
          if (sql.includes("FROM notes WHERE id = ?")) return notes.find((n) => n.id === values[0]) ?? null;
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("entity_id = ?")) return jobs.find((j) => j.entity_id === values[0] && ["pending", "processing"].includes(j.status)) ?? null;
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("json_extract")) return jobs.find((j) => j.path === values[0] && ["pending", "processing"].includes(j.status)) ?? null;
          throw new Error("Unexpected first SQL: " + sql);
        },
        async all() {
          stats.all++;
          if (sql.includes("FROM note_revisions")) return { results: revisions.filter((revision) => revision.note_id === values[0]).map((revision) => ({ content_hash: revision.content_hash })) };
          if (sql.includes("FROM yaos_sync_identity_review")) {
            const classification = sql.match(/classification = '([^']+)'/)?.[1];
            const reason = sql.match(/reason = '([^']+)'/)?.[1];
            return { results: reviews.filter((r) =>
              (classification === undefined || r.classification === classification) &&
              (reason === undefined || r.reason === reason)
            ).map((r) => ({ ...r })) };
          }
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("status = 'dead'")) return { results: jobs.filter((j) => j.entity_id === values[0] && j.status === "dead").map((j) => ({ ...j })) };
          if (sql.includes("FROM yaos_file_identity_map")) {
            const [fileId, noteId, syncUuid] = values;
            return { results: mappings.filter((m) =>
              (fileId && m.file_id === fileId) || (noteId && m.note_id === noteId) || (syncUuid && m.sync_uuid === syncUuid)
            ).map((m) => ({ ...m })) };
          }
          if (sql.includes("FROM notes WHERE sync_uuid = ?")) return { results: notes.filter((n) => n.sync_uuid === values[0]).map((n) => ({ ...n })) };
          if (sql.includes("FROM notes")) return { results: notes.map((n) => ({ ...n })) };
          throw new Error("Unexpected all SQL: " + sql);
        },
        async run() {
          stats.run++;
          const v = values;
          if (sql.startsWith("INSERT INTO yaos_sync_identity_review")) {
            const row = { file_id: v[0], path: v[1], content_hash: v[2], classification: v[3], reason: v[4], first_seen_at: v[5], last_seen_at: v[6] };
            const existing = reviews.find((r) => r.file_id === row.file_id);
            if (existing) Object.assign(existing, row, { first_seen_at: existing.first_seen_at });
            else reviews.push(row);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE note_archive_events")) return { meta: { changes: 1 } };
          if (sql.startsWith("DELETE FROM agent_memory_suppressions")) return { meta: { changes: 1 } };
          if (sql.startsWith("DELETE FROM yaos_sync_identity_review")) {
            const reason = sql.match(/reason = '([^']+)'/)?.[1];
            const before = reviews.length;
            for (let i = reviews.length - 1; i >= 0; i--) {
              if (reviews[i].file_id === v[0] && (reason === undefined || reviews[i].reason === reason)) reviews.splice(i, 1);
            }
            return { meta: { changes: before - reviews.length } };
          }
          if (sql.startsWith("INSERT INTO yaos_file_identity_map")) {
            const row = { file_id: v[0], sync_uuid: v[1], note_id: v[2], last_path: v[3], created_at: v[4], updated_at: v[5] };
            const sameFile = mappings.find((m) => m.file_id === row.file_id);
            if (sameFile && sql.includes("ON CONFLICT(file_id) DO UPDATE")) {
              if (sameFile.note_id !== row.note_id || sameFile.sync_uuid !== row.sync_uuid) throw new Error("UNIQUE constraint failed");
              sameFile.last_path = row.last_path;
              sameFile.updated_at = row.updated_at;
              return { meta: { changes: 1 } };
            }
            if (mappings.some((m) => m.file_id === row.file_id || m.note_id === row.note_id || m.sync_uuid === row.sync_uuid)) throw new Error("UNIQUE constraint failed");
            mappings.push(row);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ? WHERE id = ? AND path = ? AND sync_uuid = ? AND content_hash = ?")) {
            const row = notes.find((n) => n.id === v[1] && n.path === v[2] && n.sync_uuid === v[3] && n.content_hash === v[4] && !n.deleted_at);
            const mapping = mappings.find((m) => m.file_id === v[5] && m.note_id === v[6] && m.sync_uuid === v[7] && m.last_path === v[8]);
            if (row && mapping) row.path = v[0];
            return { meta: { changes: row && mapping ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE yaos_file_identity_map")) {
            const row = mappings.find((m) => m.file_id === v[2] && m.note_id === v[3] && m.sync_uuid === v[4] && m.last_path === v[5]);
            if (row) { row.last_path = v[0]; row.updated_at = v[1]; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE notes SET sync_uuid = ?")) {
            const row = notes.find((n) => n.id === v[1]);
            if (row && (!row.sync_uuid || row.sync_uuid === v[2])) row.sync_uuid = v[0];
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, source_modified_at")) {
            const row = notes.find((n) => n.id === v[4]);
            if (row) Object.assign(row, { path: v[0], sync_uuid: v[1], source_modified_at: v[2], imported_at: v[3] });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO yaos_sync_jobs")) {
            jobs.push({ job_id: jobs.length + 1, entity_type: v[1], entity_id: v[2], operation: v[3], payload_json: v[4], status: "pending", last_error: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO note_revisions")) {
            revisions.push({ note_id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], saved_at: v[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?")) {
            const restoring = sql.includes("deleted_at IS NOT NULL");
            const row = notes.find((n) => n.id === (restoring ? v[11] : v[9]));
            if (row) Object.assign(row, {
              path: v[0], sync_uuid: v[1], title: v[2], content: v[3], content_hash: v[4],
              source_modified_at: v[5], imported_at: v[6], updated_at: v[7], tags_json: v[8],
              ...(restoring ? { ai_allowed: v[9], review_state: v[10] } : {}), deleted_at: null
            });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE agent_memory_metadata")) return { meta: { changes: 0 } };
          if (sql.startsWith("INSERT INTO notes")) {
            const row = { id: v[0], path: v[1], sync_uuid: v[2], title: v[3], content: v[4], content_hash: v[5], source_modified_at: v[6], imported_at: v[7], updated_at: v[8], tags_json: v[9], deleted_at: null };
            if (notes.some((n) => n.id === row.id || n.path === row.path)) throw new Error("UNIQUE constraint failed");
            notes.push(row);
            return { meta: { changes: 1 } };
          }
          throw new Error("Unexpected run SQL: " + sql);
        }
      };
      return statement;
    }
  };
  return db;
}
const deps = {
  readJson: (request) => request.json(),
  json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  stableId: (path) => path.normalize("NFC").replaceAll("\\", "/"),
  titleFrom: (path, supplied) => supplied || path.split("/").at(-1).replace(/\.md$/i, ""),
  sha256: async (text) => createHash("sha256").update(text).digest("hex"),
  extractTags: (_content, tags) => tags || [],
  inspectWholeContent: () => ({ credentials: false }),
  readUuid,
  isValidSyncUuid,
  MAX_NOTES_PER_SYNC: 20,
  MAX_NOTE_CHARS: 500000,
  RESERVED_ROOT: "__system",
  prepareSyncJob: createSyncOutbox({ readUuid, isValidSyncUuid, deterministicUuid: async (id) => hash(id).slice(0, 8) + "-0000-4000-8000-000000000000" }).prepareSyncJob
};
const syncNotes = new Function(...Object.keys(deps), "return (" + syncNotesSource + ");")(...Object.values(deps));
const uuidA = "123e4567-e89b-42d3-a456-426614174001";
const uuidB = "123e4567-e89b-42d3-a456-426614174002";
const now = "2026-10-28T00:00:00.000Z";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const note = (id, path, content, sync_uuid = uuidA, deleted_at = null) => ({
  id, path, title: path.split("/").at(-1).replace(/\.md$/i, ""), content, content_hash: hash(content),
  sync_uuid, source_modified_at: null, imported_at: now, updated_at: now, tags_json: "[]", deleted_at
});
const request = (notes, observations, observationComplete = true, vaultPull = false) => new Request("https://test/api/sync", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ notes, observations, observationComplete, vaultPull })
});
const observation = (fileId, path, content, deleted = false) => ({
  fileId, path, deleted, contentHash: deleted ? "" : hash(content), legacyId: readUuid(content)
});

{
  const db = makeDb();
  const content = "# New note\n\nfirst";
  const res = await syncNotes(request([{ fileId: "file-A", path: "Notes/a.md", content }], [observation("file-A", "Notes/a.md", content)]), { DB: db });
  const result = await res.json();
  assert.equal(res.status, 200);
  assert.equal(result.created, 1, "a complete observation with a new stable fileId creates a note");
  assert.equal(db.notes.length, 1);
  assert.ok(isValidSyncUuid(db.notes[0].sync_uuid));
  assert.equal(db.notes[0].sync_uuid === readUuid(content), false);
  assert.equal(db.mappings.length, 1);
  assert.equal(db.mappings[0].file_id, "file-A");
}

{
  const original = "# Existing\n\nversion one";
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [{ file_id: "file-A", sync_uuid: uuidA, note_id: "Notes/a.md", last_path: "Notes/a.md", created_at: now, updated_at: now }]);
  const edited = "# Existing\n\nversion two";
  const res = await syncNotes(request([{ fileId: "file-A", path: "Notes/a.md", content: edited }], [observation("file-A", "Notes/a.md", edited)]), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 1, "editing a mapped note updates the same D1 row");
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].content, edited);
  assert.equal(db.revisions.length, 1, "edits preserve a revision");
}

{
  const original = "# Existing\n\nversion one";
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [{ file_id: "file-A", sync_uuid: uuidA, note_id: "Notes/a.md", last_path: "Notes/a.md", created_at: now, updated_at: now }]);
  const moved = "# Existing\n\nversion one";
  const res = await syncNotes(request([{ fileId: "file-A", path: "Archive/a.md", content: moved }], [observation("file-A", "Archive/a.md", moved)]), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 1, "a stable fileId preserves identity across a rename");
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].path, "Archive/a.md");
  assert.equal(db.notes[0].id, "Notes/a.md", "the stable D1 row ID is preserved");
  assert.equal(db.mappings[0].last_path, "Archive/a.md");
}

{
  const content = "# Similar content\\n\\nshared text with an original ending";
  const copyContent = "# Similar content\\n\\nshared text with a slightly different ending";
  const db = makeDb([note("Notes/original.md", "Notes/original.md", content)], [{ file_id: "file-original", sync_uuid: uuidA, note_id: "Notes/original.md", last_path: "Notes/original.md", created_at: now, updated_at: now }]);
  const observations = [observation("file-original", "Notes/original.md", content), observation("file-copy", "Notes/copy.md", copyContent)];
  const res = await syncNotes(request([{ fileId: "file-copy", path: "Notes/copy.md", content: copyContent }], observations), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 1, "similar content with a distinct stable fileId is a new note, not an identity match");
  assert.equal(db.notes.length, 2);
  assert.notEqual(db.notes[0].sync_uuid, db.notes[1].sync_uuid);
  assert.equal(db.mappings.length, 2);
}

{
  const existingContent = "# Existing";
  const newContent = "# New on first scan";
  const db = makeDb([note("Notes/existing.md", "Notes/existing.md", existingContent)], []);
  const observations = [observation("file-existing", "Notes/existing.md", existingContent), observation("file-new", "Notes/new.md", newContent)];
  const res = await syncNotes(request([{ fileId: "file-new", path: "Notes/new.md", content: newContent }], observations), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 1, "a confirmed-new candidate can be created without remapping every unchanged D1 note");
  assert.equal(db.notes.length, 2);
  assert.equal(db.mappings.some((m) => m.file_id === "file-existing"), false, "unchanged non-candidate observations are not queried or remapped on every pull");
  assert.equal(db.mappings.some((m) => m.file_id === "file-new"), true);
}

{
  const content = "# Maybe new";
  const db = makeDb();
  const res = await syncNotes(request([{ fileId: "file-partial", path: "Notes/partial.md", content }], [observation("file-partial", "Notes/partial.md", content)], false), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 0, "partial observations never auto-create");
  assert.equal(result.deferred, 1);
  assert.equal(db.notes.length, 0);
  assert.equal(db.reviews[0].classification, "deferred");
}

{
  const content = "# Duplicate canonical UUID";
  const db = makeDb([
    note("Notes/one.md", "Notes/one.md", content, uuidA),
    note("Notes/two.md", "Notes/two.md", content, uuidA)
  ]);
  const res = await syncNotes(request([{ fileId: "file-one", path: "Notes/one.md", content }], [observation("file-one", "Notes/one.md", content)]), { DB: db });
  const result = await res.json();
  assert.ok(result.needsReview >= 1, "duplicate D1 sync_uuid ownership for an incoming candidate fails closed");
  assert.equal(db.mappings.length, 0);
  assert.equal(db.reviews[0].classification, "needs_review");
}

{
  const legacyId = uuidA;
  const content = `---\nid: "${legacyId}"\n---\n\n# Conflicting legacy ID`;
  const db = makeDb([note("Notes/known.md", "Notes/known.md", "# Known", uuidB)], [{ file_id: "file-known", sync_uuid: uuidB, note_id: "Notes/known.md", last_path: "Notes/known.md", created_at: now, updated_at: now }]);
  const res = await syncNotes(request([{ fileId: "file-known", path: "Notes/known.md", content }], [observation("file-known", "Notes/known.md", content)]), { DB: db });
  const result = await res.json();
  assert.equal(result.needsReview, 1, "a frontmatter UUID conflicting with notes.sync_uuid is never silently adopted");
  assert.equal(db.notes[0].content, "# Known", "conflicting content is not applied");
}


{
  const content = "# Potentially new while an earlier outbox operation is pending";
  const db = makeDb();
  db.jobs.push({ entity_id: "Notes/pending.md", path: "Notes/pending.md", status: "pending" });
  const res = await syncNotes(request([{ fileId: "file-pending", path: "Notes/pending.md", content }], [observation("file-pending", "Notes/pending.md", content)]), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 0, "a pending operation for the path defers creation");
  assert.equal(result.deferred, 1);
  assert.equal(db.reviews[0].classification, "deferred");
}

{
  const content = "# File shares a path with a tombstone";
  const db = makeDb();
  const observations = [observation("file-deleted", "Notes/reused.md", content, true), observation("file-live", "Notes/reused.md", content)];
  const res = await syncNotes(request([{ fileId: "file-live", path: "Notes/reused.md", content }], observations), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 0, "a tombstone at the same path blocks automatic creation");
  assert.equal(result.needsReview, 1);
  assert.equal(db.reviews[0].classification, "needs_review");
}



{
  const content = "# A note deleted from YAOS";
  const db = makeDb([note("Notes/deleted.md", "Notes/deleted.md", content)], [{
    file_id: "file-deleted", sync_uuid: uuidA, note_id: "Notes/deleted.md",
    last_path: "Notes/deleted.md", created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([], [observation("file-deleted", "Notes/deleted.md", content, true)]), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 0, "a YAOS tombstone never recreates a deleted file as a new note");
  assert.equal(db.notes.length, 1, "an inbound tombstone does not silently delete or rewrite the D1 source of truth");
  assert.equal(db.mappings.length, 1, "the stable identity mapping remains available for an explicit restore");
}

{
  const archivedContent = "# Archived D1 copy";
  const vaultContent = "# Restored from the authoritative vault";
  const db = makeDb([note("Notes/restored.md", "Notes/restored.md", archivedContent, uuidA, "2026-10-27T00:00:00.000Z")], [{
    file_id: "file-restored", sync_uuid: uuidA, note_id: "Notes/restored.md",
    last_path: "Notes/restored.md", created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([{ fileId: "file-restored", path: "Notes/restored.md", content: vaultContent }], [observation("file-restored", "Notes/restored.md", vaultContent)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 1, "a vault pull restores an archived row at the same path");
  assert.equal(result.created, 0, "restore reuses the archived D1 row instead of creating a duplicate");
  assert.equal(db.notes[0].content, vaultContent, "the archived row is updated to the vault body");
  assert.equal(db.notes[0].deleted_at, null);
  assert.equal(db.notes[0].ai_allowed, 1, "a prior non-sensitive permission is restored from archive metadata");
  assert.equal(db.notes[0].review_state, "ready");
  assert.equal(db.revisions.length, 1, "the archived D1 body is retained as a revision before replacement");
  assert.equal(db.mappings.length, 1);
}

{
  const archivedContent = "# Archived row without an identity map";
  const vaultContent = "# Vault copy restores the archived path";
  const db = makeDb([note("Notes/restored-without-map.md", "Notes/restored-without-map.md", archivedContent, uuidB, "2026-10-27T00:00:00.000Z")]);
  const path = "Notes/restored-without-map.md";
  const res = await syncNotes(request([{ fileId: "file-restored-no-map", path, content: vaultContent }], [observation("file-restored-no-map", path, vaultContent)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 1, "a same-path archived D1 row can be restored even when no identity mapping exists");
  assert.equal(db.notes[0].content, vaultContent);
  assert.equal(db.notes[0].deleted_at, null);
  assert.equal(db.mappings.length, 1, "restore establishes the identity mapping");
  assert.equal(db.revisions.length, 1, "the archived body is preserved before replacement");
}

{
  const d1Content = "# Keep the live D1 version";
  const vaultContent = "# Different, not owner-approved";
  const path = "Notes/Unapproved/live-note.md";
  const db = makeDb([note(path, path, d1Content, uuidA)], [{
    file_id: "file-live", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([{ fileId: "file-live", path, content: vaultContent }], [observation("file-live", path, vaultContent)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 0, "vault pull does not overwrite a divergent live D1 note outside the owner-approved scope");
  assert.equal(result.needsReview, 1);
  assert.equal(db.notes[0].content, d1Content);
  assert.equal(db.reviews[0].reason, "vault_pull_live_content_conflict");
}

for (const path of [
  "Notes/電子工作/知識/16x2キャラクターLCDモジュール.md",
  "Notes/設定/ポリシー/情報の平坦化：思考速度の防衛.md",
  "Notes/設定/ポリシー/奏星のプロファイル.md",
  "Notes/設定/テーマ/グラフビュー配色定義.md",
  "Notes/Purge/経緯/Purge_リリース履歴.md"
]) {
  const d1Content = "# Old D1 content";
  const vaultContent = "# Owner-approved Obsidian content";
  const db = makeDb([note(path, path, d1Content, uuidA)], [{
    file_id: "file-approved", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([{ fileId: "file-approved", path, content: vaultContent }], [observation("file-approved", path, vaultContent)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 1, "the exact owner-approved path may follow Obsidian: " + path);
  assert.equal(db.notes[0].content, vaultContent);
}
for (const path of [
  "Notes/設定/ポリシー/unapproved-new-note.md",
  "Notes/設定/テーマ/unapproved-new-note.md",
  "Notes/設定/other/unapproved-new-note.md",
  "Notes/Purge/経緯/unapproved-new-note.md",
  "Notes/Purge/経緯/Purge_別リリース履歴.md"
]) {
  const d1Content = "# Preserve live D1 content";
  const vaultContent = "# Differing vault content";
  const db = makeDb([note(path, path, d1Content, uuidA)], [{
    file_id: "file-prefix-conflict", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([{ fileId: "file-prefix-conflict", path, content: vaultContent }], [observation("file-prefix-conflict", path, vaultContent)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.updated, 0, "directory membership alone is not owner approval to overwrite live D1 content");
  assert.equal(db.notes[0].content, d1Content);
  assert.equal(db.reviews[0].reason, "vault_pull_live_content_conflict");
}

{
  const content = "# Converged after a D1-side correction";
  const path = "Notes/Tasks/converged.md";
  const db = makeDb([note(path, path, content, uuidA)], [{
    file_id: "file-converged", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  db.reviews.push({ file_id: "file-converged", path, content_hash: hash(content), classification: "needs_review", reason: "vault_pull_live_content_conflict", first_seen_at: now, last_seen_at: now });
  const res = await syncNotes(request([], [observation("file-converged", path, content)], true, true), { DB: db });
  const result = await res.json();
  assert.equal(result.resolvedReviews, 1, "a live-content conflict that converged from the D1 side resolves itself on the next complete pull");
  assert.equal(db.reviews.length, 0, "the resolved review row is dropped");
  assert.equal(db.notes[0].content, content, "self-resolution never rewrites the note");
  const again = await syncNotes(request([], [observation("file-converged", path, content)], true, true), { DB: db });
  assert.equal((await again.json()).resolvedReviews, 0, "self-resolution is idempotent");
  assert.equal(db.reviews.length, 0);
}

{
  const d1Content = "# D1 still differs";
  const vaultContent = "# Vault version";
  const path = "Notes/Tasks/still-divergent.md";
  const db = makeDb([note(path, path, d1Content, uuidA)], [{
    file_id: "file-divergent", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  db.reviews.push({ file_id: "file-divergent", path, content_hash: hash(vaultContent), classification: "needs_review", reason: "vault_pull_live_content_conflict", first_seen_at: now, last_seen_at: now });
  const res = await syncNotes(request([], [observation("file-divergent", path, vaultContent)], true, true), { DB: db });
  assert.equal((await res.json()).resolvedReviews, 0, "a note whose content still differs keeps its review row");
  assert.equal(db.reviews.length, 1);
}

{
  const content = "# Identity mapping recovered";
  const path = "Notes/Tasks/identity-row.md";
  const seed = ({ mappingCount = 1, noteDeleted = false, notePath = path, mappingPath = path, mappingNoteId = path, mappingUuid = uuidA, observationPath = path, observedContent = content, pending = false } = {}) => {
    const db = makeDb([note(path, notePath, content, uuidA, noteDeleted ? now : null)], Array.from({ length: mappingCount }, (_, index) => ({
      file_id: "file-identity-row", sync_uuid: mappingUuid, note_id: mappingNoteId, last_path: mappingPath, created_at: now, updated_at: now,
      ...(index ? { duplicate: index } : {})
    })));
    db.reviews.push({ file_id: "file-identity-row", path: "Notes/Inbox/old-location.md", content_hash: "historical-hash", classification: "needs_review", reason: "sync_identity_mapping_conflict", first_seen_at: now, last_seen_at: now });
    if (pending) db.jobs.push({ entity_id: path, status: "processing" });
    return { db, observations: [observation("file-identity-row", observationPath, observedContent)] };
  };
  const healthy = seed();
  const healthyRes = await syncNotes(request([], healthy.observations, true, true), { DB: healthy.db });
  assert.equal((await healthyRes.json()).resolvedReviews, 1, "a current, unique mapping with matching live note, path, hash, and no pending job resolves the row even when its historical path/hash are stale");
  assert.equal(healthy.db.reviews.length, 0);

  const cases = [
    ["zero mappings", { mappingCount: 0 }],
    ["duplicate mappings", { mappingCount: 2 }],
    ["deleted note", { noteDeleted: true }],
    ["note path mismatch", { notePath: "Notes/Tasks/other.md" }],
    ["mapping last_path mismatch", { mappingPath: "Notes/Tasks/other.md" }],
    ["mapping note_id mismatch", { mappingNoteId: "Notes/Tasks/other.md" }],
    ["mapping sync_uuid mismatch", { mappingUuid: uuidB }],
    ["observation path mismatch", { observationPath: "Notes/Tasks/other.md" }],
    ["content hash mismatch", { observedContent: "# Different Vault content" }],
    ["pending outbox", { pending: true }]
  ];
  for (const [label, options] of cases) {
    const test = seed(options);
    const response = await syncNotes(request([], test.observations, true, true), { DB: test.db });
    assert.equal((await response.json()).resolvedReviews, 0, label + " must retain the mapping-conflict review");
    assert.equal(test.db.reviews.length, 1, label + " must not delete the review row");
  }

  const partial = seed();
  const partialRes = await syncNotes(request([], partial.observations, false, true), { DB: partial.db });
  assert.equal((await partialRes.json()).resolvedReviews, 0, "incomplete observations never resolve mapping reviews");
  assert.equal(partial.db.reviews.length, 1);
  const nonPull = seed();
  const nonPullRes = await syncNotes(request([], nonPull.observations, true, false), { DB: nonPull.db });
  assert.equal((await nonPullRes.json()).resolvedReviews, 0, "non-pull sync never resolves mapping reviews");
  assert.equal(nonPull.db.reviews.length, 1);
}

{
  const content = "# Converged but delivery in flight";
  const path = "Notes/Tasks/in-flight.md";
  const db = makeDb([note(path, path, content, uuidA)], [{
    file_id: "file-in-flight", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
  }]);
  db.reviews.push({ file_id: "file-in-flight", path, content_hash: hash(content), classification: "needs_review", reason: "vault_pull_live_content_conflict", first_seen_at: now, last_seen_at: now });
  db.jobs.push({ entity_id: path, path, status: "pending" });
  const res = await syncNotes(request([], [observation("file-in-flight", path, content)], true, true), { DB: db });
  assert.equal((await res.json()).resolvedReviews, 0, "a pending outbox operation keeps the review row until delivery settles");
  assert.equal(db.reviews.length, 1);
}

{
  const content = "# Converged";
  const path = "Notes/Tasks/guards.md";
  const seed = () => {
    const db = makeDb([note(path, path, content, uuidA)], [{
      file_id: "file-guards", sync_uuid: uuidA, note_id: path, last_path: path, created_at: now, updated_at: now
    }]);
    db.reviews.push({ file_id: "file-guards", path, content_hash: hash(content), classification: "needs_review", reason: "vault_pull_live_content_conflict", first_seen_at: now, last_seen_at: now });
    return db;
  };
  const partial = seed();
  const partialRes = await syncNotes(request([], [observation("file-guards", path, content)], false, true), { DB: partial });
  assert.equal((await partialRes.json()).resolvedReviews, 0, "a partial observation never resolves review rows");
  assert.equal(partial.reviews.length, 1);
  const plainSync = seed();
  const plainRes = await syncNotes(request([], [observation("file-guards", path, content)], true, false), { DB: plainSync });
  assert.equal((await plainRes.json()).resolvedReviews, 0, "a non-pull sync never resolves review rows");
  assert.equal(plainSync.reviews.length, 1);
  const tombstoned = seed();
  const tombstoneRes = await syncNotes(request([], [observation("file-guards", path, content, true)], true, true), { DB: tombstoned });
  assert.equal((await tombstoneRes.json()).resolvedReviews, 0, "a tombstoned vault entry never resolves review rows");
  assert.equal(tombstoned.reviews.length, 1);
}

{
  const content = "# Pull candidate";
  const unrelated = Array.from({ length: 600 }, (_, i) => observation("unchanged-" + i, "Notes/unchanged-" + i + ".md", "# unchanged"));
  const observations = [observation("candidate", "Notes/candidate.md", content), ...unrelated];
  const db = makeDb();
  const res = await syncNotes(request([{ fileId: "candidate", path: "Notes/candidate.md", content }], observations), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 1);
  assert.ok(Object.values(db.stats).reduce((sum, count) => sum + count, 0) < 20,
    "600 unrelated vault observations must not fan out into hundreds of D1 queries/writes");
}

{
  const oldPath = "Notes/私について/石田について.md";
  const newPath = "Notes/私について/私について.md";
  const fileId = "D-StnCzgUF3w5Zdl";
  const syncUuid = "5bd3f3ba-818d-4a4d-ac95-074ea2a9fe28";
  const oldContent = "# 石田について\n\n既存の本文。\n";
  const vaultContent = oldContent.replace(/\n/g, "\r\n");
  const latestContent = oldContent + "\n## 追記した節\n\nAPI correction で追加した本文。\n";
  const observedAt = "2026-10-31T14:31:10Z";
  const db = makeDb(
    [note(oldPath, oldPath, latestContent, syncUuid)],
    [{ file_id: fileId, sync_uuid: syncUuid, note_id: oldPath, last_path: newPath, created_at: observedAt, updated_at: observedAt }]
  );
  db.revisions.push({ note_id: oldPath, content: oldContent, content_hash: hash(oldContent), saved_at: observedAt });
  db.reviews.push({
    file_id: fileId, path: newPath, content_hash: hash(vaultContent), classification: "needs_review",
    reason: "vault_pull_live_content_conflict", first_seen_at: observedAt, last_seen_at: observedAt
  });
  db.jobs.push({
    job_id: 41, entity_type: "notes", entity_id: oldPath, operation: "upsert", status: "dead",
    payload_json: JSON.stringify({ id: oldPath, path: oldPath, content: latestContent, contentHash: hash(latestContent), syncUuid, expectedPreviousContent: oldContent }),
    last_error: "vault_content_conflict"
  });
  const response = await syncNotes(request(
    [{ fileId, path: newPath, content: vaultContent }],
    [observation(fileId, newPath, vaultContent)],
    true,
    true
  ), { DB: db });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.reconciledRenames, 1, "known fileId plus the exact previous D1 revision safely reconciles the rename");
  assert.equal(result.resolvedReviews, 1, "the resolved conflict is counted");
  assert.equal(db.notes[0].path, newPath, "D1 adopts the Vault's renamed path");
  assert.equal(db.notes[0].content, latestContent, "the newer D1 correction body is preserved");
  assert.equal(db.notes[0].sync_uuid, syncUuid, "the authoritative sync_uuid is unchanged");
  assert.equal(db.mappings[0].last_path, newPath, "the identity mapping converges on the new path");
  assert.equal(db.mappings[0].sync_uuid, syncUuid);
  assert.equal(db.reviews.length, 0, "the exact live-content conflict review is removed");
  const pending = db.jobs.find((job) => job.status === "pending");
  assert.ok(pending, "a fresh upsert is queued after the old dead delivery");
  const payload = JSON.parse(pending.payload_json);
  assert.equal(payload.path, newPath);
  assert.equal(payload.content, latestContent);
  assert.equal(payload.contentHash, hash(latestContent));
  assert.equal(payload.syncUuid, syncUuid);
  assert.equal(payload.expectedPreviousContent, vaultContent, "YAOS can compare against the exact observed old body, with line endings preserved");
  assert.equal(db.jobs.find((job) => job.job_id === 41).status, "dead", "the original dead-letter evidence is preserved");
}

{
  const oldPath = "Notes/改善/複数回編集された競合.md";
  const newPath = "Notes/改善/複数回編集された競合_改名後.md";
  const fileId = "improvement-chain-file";
  const syncUuid = "123e4567-e89b-42d3-a456-426614174099";
  const vaultContent = "# 改善\n\nVault に残った版。\n";
  const intermediate = vaultContent + "\n## 中間編集\n\n1回目の API 編集。\n";
  const latest = intermediate + "\n## 最新編集\n\n2回目の API 編集。\n";
  const observedAt = "2026-10-31T14:31:10Z";
  const db = makeDb(
    [note(oldPath, oldPath, latest, syncUuid)],
    [{ file_id: fileId, sync_uuid: syncUuid, note_id: oldPath, last_path: newPath, created_at: observedAt, updated_at: observedAt }]
  );
  db.revisions.push(
    { note_id: oldPath, content: vaultContent, content_hash: hash(vaultContent), saved_at: observedAt },
    { note_id: oldPath, content: intermediate, content_hash: hash(intermediate), saved_at: observedAt }
  );
  db.reviews.push({
    file_id: fileId, path: newPath, content_hash: hash(vaultContent), classification: "needs_review",
    reason: "vault_pull_live_content_conflict", first_seen_at: observedAt, last_seen_at: observedAt
  });
  db.jobs.push(
    { job_id: 51, entity_type: "notes", entity_id: oldPath, operation: "upsert", status: "dead",
      payload_json: JSON.stringify({ id: oldPath, path: oldPath, content: intermediate, contentHash: hash(intermediate), syncUuid, expectedPreviousContent: vaultContent }),
      last_error: "Error: vault_content_conflict" },
    { job_id: 52, entity_type: "notes", entity_id: oldPath, operation: "upsert", status: "dead",
      payload_json: JSON.stringify({ id: oldPath, path: oldPath, content: latest, contentHash: hash(latest), syncUuid, expectedPreviousContent: intermediate }),
      last_error: "Error: vault_content_conflict" }
  );
  const response = await syncNotes(request(
    [{ fileId, path: newPath, content: vaultContent }],
    [observation(fileId, newPath, vaultContent)],
    true,
    true
  ), { DB: db });
  const result = await response.json();
  assert.equal(result.reconciledRenames, 1, "a continuous chain of dead D1 upserts proves multiple API edits after the Vault baseline");
  assert.equal(db.notes[0].path, newPath);
  assert.equal(db.notes[0].content, latest);
  assert.equal(db.notes[0].sync_uuid, syncUuid);
  assert.equal(db.reviews.length, 0);
  const pending = db.jobs.find((job) => job.status === "pending");
  assert.ok(pending);
  const payload = JSON.parse(pending.payload_json);
  assert.equal(payload.content, latest);
  assert.equal(payload.expectedPreviousContent, vaultContent);
}

console.log("Sync identity separation tests passed: create, edit/revision, rename, copy/similar-content, delete tombstone, guarded archived restore, exact five-path Obsidian allowlist, live-D1 conflict refusal, live-content and identity-mapping review self-resolution, bounded candidate reconciliation, partial observation, pending operation, tombstone conflict, duplicate UUID, and frontmatter conflict.");
