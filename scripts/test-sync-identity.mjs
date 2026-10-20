import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncNotes(request, env)");
const marker = '__name(syncNotes, "syncNotes");';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "Could not extract syncNotes from the Worker bundle");
const syncNotesSource = source.slice(start, end).trim()
  .replaceAll(String.fromCharCode(92, 96), String.fromCharCode(96))
  .replaceAll(String.fromCharCode(92, 36, 123), String.fromCharCode(36, 123));

function readUuid(content) {
  const fm = content.slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  return fm[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
}
function isValidSyncUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function deterministicUuid(seed) {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = "89ab"[parseInt(digest[16], 16) & 3];
  return digest.slice(0, 8).join("") + "-" + digest.slice(8, 12).join("") + "-" + digest.slice(12, 16).join("") + "-" + digest.slice(16, 20).join("") + "-" + digest.slice(20, 32).join("");
}
function makeDb(initialNotes = []) {
  const notes = structuredClone(initialNotes);
  const revisions = [];
  const relations = [];
  const archiveEvents = [];
  const telegramActions = [];
  const db = {
    notes, revisions, relations, archiveEvents, telegramActions,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM notes WHERE path = ?")) {
            const [path] = this.values;
            return notes.find((n) => n.path === path) ?? null;
          }
          throw new Error("Unexpected first SQL: " + sql);
        },
        async all() {
          if (sql.includes("FROM notes WHERE sync_uuid = ?")) {
            const [uuid] = this.values;
            return { results: notes.filter((n) => n.sync_uuid === uuid).map((n) => ({ ...n })) };
          }
          if (sql.includes("FROM notes")) return { results: notes.map((n) => ({ ...n })) };
          throw new Error("Unexpected all SQL: " + sql);
        },
        async run() {
          const v = this.values;
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, source_modified_at")) {
            const row = notes.find((n) => n.id === v[4]);
            if (row) Object.assign(row, { path: v[0], sync_uuid: v[1], source_modified_at: v[2], imported_at: v[3], deleted_at: null });
            return { meta: { changes: row ? 1 : 0 } };
          }
                    if (sql.startsWith("INSERT INTO note_revisions")) {
            revisions.push({ note_id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], saved_at: v[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?")) {
            const row = notes.find((n) => n.id === v[9]);
            if (row) Object.assign(row, { path: v[0], sync_uuid: v[1], title: v[2], content: v[3], content_hash: v[4], source_modified_at: v[5], imported_at: v[6], updated_at: v[7], tags_json: v[8], summary: null, ai_tags_json: "[]", related_json: "[]", organized_hash: null, organization_failures: 0, last_failure_stage: null, next_retry_at: null, review_state: "ready", deleted_at: null });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO notes")) {
            notes.push({ id: v[0], path: v[1], sync_uuid: v[2], title: v[3], content: v[4], content_hash: v[5], source_modified_at: v[6], imported_at: v[7], updated_at: v[8], tags_json: v[9], deleted_at: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE note_revisions SET note_id = ?")) {
            for (const row of revisions) if (row.note_id === v[1]) row.note_id = v[0];
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE note_relations SET source_note_id = ?")) return { meta: { changes: 1 } };
          if (sql.startsWith("UPDATE note_relations SET target_note_id = ?")) return { meta: { changes: 1 } };
          if (sql.startsWith("UPDATE note_archive_events SET note_id = ?")) return { meta: { changes: 1 } };
          if (sql.startsWith("UPDATE telegram_note_actions SET note_id = ?")) return { meta: { changes: 1 } };
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
  stableId: (path) => path,
  titleFrom: (path, supplied) => supplied || path.split("/").at(-1).replace(/\.md$/i, ""),
  sha256: async (text) => "hash:" + text,
  extractTags: (_content, tags) => tags || [],
  readUuid,
  isValidSyncUuid,
  deterministicUuid,
  MAX_NOTES_PER_SYNC: 500,
  MAX_NOTE_CHARS: 200000
};
const syncNotes = new Function(...Object.keys(deps), "return (" + syncNotesSource + ");")(...Object.values(deps));
const syncUuid = await deterministicUuid("notes:old/path.md");
const originalContent = "Legacy note without an id property";
const movedContent = `---\nid: "${syncUuid}"\n---\n\nLegacy note without an id property`;
const oldRow = { id: "old/path.md", path: "old/path.md", sync_uuid: syncUuid, title: "Note", content: originalContent, content_hash: "hash:" + originalContent, source_modified_at: null, imported_at: "old", updated_at: "old", tags_json: "[]", deleted_at: null };

{
  const db = makeDb([oldRow]);
  const request = new Request("https://test/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ path: "new/path.md", title: "Note", content: movedContent }] }) });
  const response = await syncNotes(request, { DB: db });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.created, 0, "A path move must not create a duplicate note");
  assert.equal(result.updated, 1, "A path move must be reported as an update");
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].id, "old/path.md", "A path move preserves the stable D1 row ID");
  assert.equal(db.notes[0].path, "new/path.md");
  assert.equal(db.notes[0].sync_uuid, syncUuid, "The UUID remains stable across the path move");
  assert.equal(db.notes[0].content, movedContent);
}

{
  const duplicate = { ...oldRow, id: "another.md", path: "another.md" };
  const db = makeDb([oldRow, duplicate]);
  const request = new Request("https://test/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ path: "new/path.md", title: "Note", content: movedContent }] }) });
  const response = await syncNotes(request, { DB: db });
  const result = await response.json();
  assert.equal(response.status, 409, "Duplicate UUIDs must fail closed");
  assert.equal(result.error, "ambiguous_sync_uuid");
  assert.equal(db.notes.length, 2, "Ambiguous identities must not be mutated");
  assert.equal(db.notes[0].path, "old/path.md");
  assert.equal(db.notes[1].path, "another.md");
}


{
  const archived = { ...oldRow, deleted_at: "2026-10-19T10:00:00.000Z" };
  const db = makeDb([archived]);
  const request = new Request("https://test/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ path: "old/path.md", title: "Note", content: movedContent }] }) });
  const response = await syncNotes(request, { DB: db });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.archivedSkipped, 1, "An archived note must be skipped rather than reactivated");
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].deleted_at, archived.deleted_at, "The archived timestamp must remain unchanged");
  assert.equal(db.notes[0].content, originalContent, "An archived note's content must not be overwritten");
}

console.log("Sync identity behavior tests passed.");
