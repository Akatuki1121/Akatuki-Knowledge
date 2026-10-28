import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncNotes(request, env) {");
const marker = '__name(syncNotes, "syncNotes");';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "Could not extract syncNotes from the Worker bundle");
const syncNotesSource = source.slice(start, end);
const identityMigration = await readFile(new URL("../migrations/pending/0015_yaos_file_identity_map.sql", import.meta.url), "utf8");
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
  const notes = structuredClone(initialNotes);
  const mappings = structuredClone(initialMappings);
  const reviews = [];
  const revisions = [];
  const jobs = [];
  const db = {
    notes, mappings, reviews, revisions, jobs,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return this; },
        async first() {
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
          const v = values;
          if (sql.startsWith("INSERT INTO yaos_sync_identity_review")) {
            const row = { file_id: v[0], path: v[1], content_hash: v[2], classification: v[3], reason: v[4], first_seen_at: v[5], last_seen_at: v[6] };
            const existing = reviews.find((r) => r.file_id === row.file_id);
            if (existing) Object.assign(existing, row, { first_seen_at: existing.first_seen_at });
            else reviews.push(row);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM yaos_sync_identity_review")) {
            const before = reviews.length;
            for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].file_id === v[0]) reviews.splice(i, 1);
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
          if (sql.startsWith("UPDATE yaos_file_identity_map")) {
            const row = mappings.find((m) => m.file_id === v[2] && m.note_id === v[3] && m.sync_uuid === v[4]);
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
          if (sql.startsWith("INSERT INTO note_revisions")) {
            revisions.push({ note_id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], saved_at: v[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?")) {
            const row = notes.find((n) => n.id === v[9]);
            if (row) Object.assign(row, { path: v[0], sync_uuid: v[1], title: v[2], content: v[3], content_hash: v[4], source_modified_at: v[5], imported_at: v[6], updated_at: v[7], tags_json: v[8], deleted_at: null });
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
  readUuid,
  isValidSyncUuid,
  MAX_NOTES_PER_SYNC: 20,
  MAX_NOTE_CHARS: 500000,
  RESERVED_ROOT: "__system"
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
const request = (notes, observations, observationComplete = true) => new Request("https://test/api/sync", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ notes, observations, observationComplete })
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
  const content = "# Same content\n\nidentical body";
  const db = makeDb([note("Notes/original.md", "Notes/original.md", content)], [{ file_id: "file-original", sync_uuid: uuidA, note_id: "Notes/original.md", last_path: "Notes/original.md", created_at: now, updated_at: now }]);
  const observations = [observation("file-original", "Notes/original.md", content), observation("file-copy", "Notes/copy.md", content)];
  const res = await syncNotes(request([{ fileId: "file-copy", path: "Notes/copy.md", content }], observations), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 1, "identical content with a distinct fileId is a new copy, not a merge");
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
  assert.equal(result.created, 1, "initial reconciliation maps existing D1 notes before creating confirmed-new files");
  assert.equal(db.notes.length, 2);
  assert.equal(db.mappings.some((m) => m.file_id === "file-existing"), true);
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
  const res = await syncNotes(request([], [observation("file-one", "Notes/one.md", content)]), { DB: db });
  const result = await res.json();
  assert.equal(result.needsReview, 1, "duplicate D1 sync_uuid ownership fails closed");
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
  const content = "# Restored without a frontmatter identifier";
  const db = makeDb([note("Notes/restored.md", "Notes/restored.md", content, uuidA, "2026-10-27T00:00:00.000Z")], [{
    file_id: "file-restored", sync_uuid: uuidA, note_id: "Notes/restored.md",
    last_path: "Notes/restored.md", created_at: now, updated_at: now
  }]);
  const res = await syncNotes(request([{ fileId: "file-restored", path: "Notes/restored.md", content }], [observation("file-restored", "Notes/restored.md", content)]), { DB: db });
  const result = await res.json();
  assert.equal(result.created, 0, "a restored-looking Vault file cannot silently resurrect an archived D1 note");
  assert.equal(result.needsReview, 1, "restore requires an explicit D1-side restore operation");
  assert.equal(db.notes[0].deleted_at, "2026-10-27T00:00:00.000Z");
  assert.equal(db.mappings.length, 1);
}

console.log("Sync identity separation tests passed: create, edit/revision, rename, copy/similar-content, delete tombstone, explicit restore boundary, initial reconciliation, partial observation, pending operation, tombstone conflict, duplicate UUID, and frontmatter conflict.");
