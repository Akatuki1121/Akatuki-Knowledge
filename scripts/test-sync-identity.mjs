import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncNotes(request, env)");
const marker = '__name(syncNotes, "syncNotes");';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "Could not extract syncNotes from the Worker bundle");
const syncNotesSource = source.slice(start, end).trim();

function readUuid(content) {
  const fm = content.slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  return fm[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
}
function makeDb(initialNotes = []) {
  const notes = structuredClone(initialNotes);
  const revisions = [];
  return {
    notes,
    revisions,
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
          if (sql.includes("FROM notes")) return { results: notes.map((n) => ({ ...n })) };
          throw new Error("Unexpected all SQL: " + sql);
        },
        async run() {
          const v = this.values;
          if (sql.startsWith("UPDATE notes SET path = ?, source_modified_at")) {
            const row = notes.find((n) => n.id === v[3]);
            if (row) { row.path = v[0]; row.source_modified_at = v[1]; row.imported_at = v[2]; row.deleted_at = null; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO note_revisions")) {
            revisions.push({ note_id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], saved_at: v[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, title = ?, content = ?, content_hash = ?")) {
            const row = notes.find((n) => n.id === v[8]);
            if (row) Object.assign(row, { path: v[0], title: v[1], content: v[2], content_hash: v[3], source_modified_at: v[4], imported_at: v[5], updated_at: v[6], tags_json: v[7], summary: null, ai_tags_json: "[]", related_json: "[]", organized_hash: null, organization_failures: 0, last_failure_stage: null, next_retry_at: null, review_state: "ready", deleted_at: null });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO notes")) {
            notes.push({ id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], source_modified_at: v[5], imported_at: v[6], updated_at: v[7], tags_json: v[8], deleted_at: null });
            return { meta: { changes: 1 } };
          }
          throw new Error("Unexpected run SQL: " + sql);
        }
      };
      return statement;
    }
  };
}
const deps = {
  readJson: (request) => request.json(),
  json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  stableId: (path) => path,
  titleFrom: (path, supplied) => supplied || path.split("/").at(-1).replace(/\.md$/i, ""),
  sha256: async (text) => "hash:" + text,
  extractTags: (_content, tags) => tags || [],
  readUuid,
  MAX_NOTES_PER_SYNC: 500,
  MAX_NOTE_CHARS: 200000
};
const syncNotes = new Function(...Object.keys(deps), "return (" + syncNotesSource + ");")(...Object.values(deps));
const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
const originalContent = `---\nid: "${uuid}"\n---\n\nA note`;
const oldRow = { id: "old/path.md", path: "old/path.md", title: "Note", content: originalContent, content_hash: "hash:" + originalContent, source_modified_at: null, imported_at: "old", updated_at: "old", tags_json: "[]", deleted_at: null };

{
  const db = makeDb([oldRow]);
  const request = new Request("https://test/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ path: "new/path.md", title: "Note", content: originalContent }] }) });
  const response = await syncNotes(request, { DB: db });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.created, 0, "A path move must not create a duplicate note");
  assert.equal(result.updated, 1, "A path move must be reported as an update");
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].id, "old/path.md", "The stable D1 ID must survive a path move");
  assert.equal(db.notes[0].path, "new/path.md");
}

{
  const duplicate = { ...oldRow, id: "another.md", path: "another.md" };
  const db = makeDb([oldRow, duplicate]);
  const request = new Request("https://test/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ path: "new/path.md", title: "Note", content: originalContent }] }) });
  const response = await syncNotes(request, { DB: db });
  const result = await response.json();
  assert.equal(response.status, 409, "Duplicate UUIDs must fail closed");
  assert.equal(result.error, "ambiguous_sync_uuid");
  assert.equal(db.notes.length, 2, "Ambiguous identities must not be mutated");
  assert.equal(db.notes[0].path, "old/path.md");
  assert.equal(db.notes[1].path, "another.md");
}

console.log("Sync identity behavior tests passed.");
