import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async reconcileExistingNoteIds() {");
const end = source.indexOf("\n  // 段階2a:", start);
assert.ok(start >= 0 && end > start, "Could not extract reconcileExistingNoteIds");
const method = source.slice(start, end).trim();

class YMap extends Map {}
class YText {
  constructor(value = "") { this.value = value; }
  toString() { return this.value; }
  get length() { return this.value.length; }
  delete(start, length) { this.value = this.value.slice(0, start) + this.value.slice(start + length); }
  insert(index, value) { this.value = this.value.slice(0, index) + value + this.value.slice(index); }
}
class Doc {
  constructor() { this.maps = new Map(); }
  getMap(name) {
    if (!this.maps.has(name)) this.maps.set(name, new YMap());
    return this.maps.get(name);
  }
  transact(callback) { callback(); }
}
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const uuid2 = "223e4567-e89b-42d3-a456-426614174000";
const readUuid = (content) => content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^id:\s*["']?([0-9a-f-]+)["']?\s*$/im)?.[1] ?? null;
const isValidSyncUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const deterministicUuid = async () => uuid;
const sha256Hex = async (value) => "hash:" + value.length;
const MAX_NOTE_CHARS = 500000;
const norm = (value) => String(value ?? "").replaceAll("\\", "/").normalize("NFC");
const RESERVED_ROOT = ".yaos";
const WORKER_DEVICE = "test-worker";
const MIN_VAULT_FILES_FOR_WRITE = 1;
const deps = { YMap, YText, Doc, readUuid, isValidSyncUuid, deterministicUuid, sha256Hex, norm, RESERVED_ROOT, WORKER_DEVICE, MIN_VAULT_FILES_FOR_WRITE, MAX_NOTE_CHARS };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + method + " }")(...Object.values(deps));

function setup(rows, vaultFiles) {
  const revisions = [];
  const doc = new Doc();
  const meta = doc.getMap("meta"), texts = doc.getMap("idToText");
  doc.getMap("sys").set("initialized", true);
  for (const [i, file] of vaultFiles.entries()) {
    const fileId = "file-" + i;
    const entry = new YMap();
    entry.set("path", file.path);
    if (file.deleted) entry.set("deletedAt", 1);
    meta.set(fileId, entry);
    texts.set(fileId, new YText(file.content));
  }
  const instance = new TestDO();
  instance.env = {
    DB: {
      prepare(sql) {
        if (sql.startsWith("SELECT ")) return { all: async () => ({ results: rows }) };
        return {
          bind(...args) {
            return {
              run: async () => {
                if (sql.startsWith("INSERT INTO note_revisions")) { revisions.push({ sql, args }); return { meta: { changes: 1 } }; }
                if (sql.startsWith("UPDATE notes SET content =")) {
                  const [content, contentHash, syncUuid, importedAt, updatedAt, id] = args;
                  const row = rows.find((item) => item.id === id);
                  if (row) Object.assign(row, { content, content_hash: contentHash, sync_uuid: syncUuid, imported_at: importedAt, updated_at: updatedAt });
                  return { meta: { changes: row ? 1 : 0 } };
                }
                if (sql.startsWith("UPDATE notes SET sync_uuid =")) {
                  const [syncUuid, id] = args;
                  const row = rows.find((item) => item.id === id);
                  if (row) row.sync_uuid = syncUuid;
                  return { meta: { changes: row ? 1 : 0 } };
                }
                throw new Error("Unexpected SQL in test: " + sql);
              }
            };
          }
        };
      },      batch: async (statements) => Promise.all(statements.map((statement) => statement.run()))
    }
  };
  instance.pullVault = async (callback) => {
    if (callback) callback(doc);
    return doc;
  };
  return { instance, doc, rows, texts, revisions };
}

const body = "---\ntags: [\"#example\"]\n---\n\noriginal note";
{
  const { instance, rows, texts, revisions } = setup([{ id: "Notes/example.md", path: "Notes/example.md", title: "Example", content: body, content_hash: "old-hash", sync_uuid: uuid }], [{ path: "Notes/example.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.equal(result.verified, 1);
  assert.equal(readUuid(texts.get("file-0").toString()), uuid);
  assert.equal(rows[0].sync_uuid, uuid);
  assert.ok(texts.get("file-0").toString().includes("original note"));
  assert.equal(readUuid(rows[0].content), uuid, "D1 content must be reconciled with the verified Vault frontmatter");
  assert.equal(revisions.length, 1, "The previous D1 content must be retained as a revision");
}

{
  const { instance, texts } = setup([{ id: "Notes/missing.md", path: "Notes/missing.md", content: body, sync_uuid: uuid }], [{ path: "Notes/other.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.missingInVault, 1);
  assert.deepEqual(result.missingNoteIds, ["Notes/missing.md"]);
  assert.equal(result.changed, 0);
  assert.equal(texts.get("file-0").toString(), body, "Missing Vault files must never be recreated");
}

{
  const { instance, texts } = setup([{ id: "Notes/example.md", path: "Notes/example.md", content: body, sync_uuid: uuid }], [{ path: "Notes/example.md", content: body.replace("original note", "independent edit") }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.contentConflicts, 1);
  assert.equal(result.changed, 0);
  assert.ok(texts.get("file-0").toString().includes("independent edit"), "Conflicting Vault content must remain untouched");
}

{
  const existing = `---\nid: "${uuid2}"\ntags: ["#example"]\n---\n\noriginal note`;
  const { instance, rows, texts, revisions } = setup([{ id: "Notes/example.md", path: "Notes/example.md", title: "Example", content: body, content_hash: "old-hash", sync_uuid: uuid }], [{ path: "Notes/example.md", content: existing }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.alreadyAligned, 1);
  assert.equal(result.changed, 0);
  assert.equal(rows[0].sync_uuid, uuid2, "An existing Vault identity must be preserved");
  assert.equal(texts.get("file-0").toString(), existing);
  assert.equal(rows[0].content, existing, "D1 must preserve the existing Vault UUID");
  assert.equal(revisions.length, 1);
}


{
  const dotBody = "A valid article whose filename begins with a dot.";
  const path = "Notes/プログラミング/知識/.gitattributes ファイル解説.md";
  const { instance, rows, texts, revisions } = setup([{ id: path, path, title: "gitattributes article", content: dotBody, content_hash: "old-hash", sync_uuid: uuid }], [{ path, content: dotBody }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 1, "Dot-prefixed filenames are valid Markdown notes, not hidden directories");
  assert.equal(readUuid(texts.get("file-0").toString()), uuid);
  assert.equal(readUuid(rows[0].content), uuid);
  assert.equal(revisions.length, 1);
}


{
  const path = "Notes/renamed.md";
  const existing = `---\\nid: "${uuid}"\\ntags: ["#example"]\\n---\\n\\noriginal note`;
  const { instance } = setup([{ id: path, path, content: body, sync_uuid: uuid }], [{ path: "Notes/current-name.md", content: existing }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.uuidPathMismatch, 1, "A UUID at a different path must not be recreated or renamed automatically");
  assert.deepEqual(result.missingNoteIds, []);
}

{
  const path = "Notes/.private/note.md";
  const { instance } = setup([{ id: path, path, content: body, sync_uuid: uuid }], [{ path: "Notes/other.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.unsafeMissingPaths, 1);
  assert.deepEqual(result.missingNoteIds, [], "Hidden-directory paths must not be recreated");
}

{
  const path = "Notes/プログラミング/知識/.gitattributes ファイル解説.md";
  const { instance } = setup([{ id: path, path, content: "article", sync_uuid: uuid }], [{ path: "Notes/other.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.deepEqual(result.missingNoteIds, [path], "A dot-prefixed filename in a visible directory is eligible for safe restoration");
  assert.ok(source.includes('desiredPath.split("/").slice(0, -1).some((part) => part.startsWith("."))'), "Sync path validation must allow dot-prefixed filenames while blocking hidden directories");
}

{
  const path = "Notes/deleted.md";
  const { instance } = setup([{ id: path, path, content: body, sync_uuid: uuid }], [{ path, content: body, deleted: true }, { path: "Notes/other.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.tombstonedInVault, 1);
  assert.deepEqual(result.missingNoteIds, [], "A YAOS tombstone must not be resurrected automatically");
}

console.log("Safe existing-note ID recovery tests passed.");
