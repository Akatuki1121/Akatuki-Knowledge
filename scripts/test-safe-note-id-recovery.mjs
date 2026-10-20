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
const norm = (value) => String(value ?? "").replaceAll("\\", "/").normalize("NFC");
const RESERVED_ROOT = ".yaos";
const WORKER_DEVICE = "test-worker";
const MIN_VAULT_FILES_FOR_WRITE = 1;
const deps = { YMap, YText, Doc, readUuid, isValidSyncUuid, deterministicUuid, norm, RESERVED_ROOT, WORKER_DEVICE, MIN_VAULT_FILES_FOR_WRITE };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + method + " }")(...Object.values(deps));

function setup(rows, vaultFiles) {
  const doc = new Doc();
  const meta = doc.getMap("meta"), texts = doc.getMap("idToText");
  doc.getMap("sys").set("initialized", true);
  for (const [i, file] of vaultFiles.entries()) {
    const fileId = "file-" + i;
    const entry = new YMap();
    entry.set("path", file.path);
    meta.set(fileId, entry);
    texts.set(fileId, new YText(file.content));
  }
  const instance = new TestDO();
  instance.env = {
    DB: {
      prepare(sql) {
        return {
          all: async () => ({ results: rows }),
          bind(...args) {
            return {
              run: async () => {
                const [syncUuid, id] = args;
                const row = rows.find((item) => item.id === id);
                if (row) row.sync_uuid = syncUuid;
                return { meta: { changes: row ? 1 : 0 } };
              }
            };
          }
        };
      },
      batch: async (statements) => Promise.all(statements.map((statement) => statement.run()))
    }
  };
  instance.pullVault = async (callback) => {
    if (callback) callback(doc);
    return doc;
  };
  return { instance, doc, rows, texts };
}

const body = "---\ntags: [\"#example\"]\n---\n\noriginal note";
{
  const { instance, rows, texts } = setup([{ id: "Notes/example.md", path: "Notes/example.md", content: body, sync_uuid: uuid }], [{ path: "Notes/example.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.equal(result.verified, 1);
  assert.equal(readUuid(texts.get("file-0").toString()), uuid);
  assert.equal(rows[0].sync_uuid, uuid);
  assert.ok(texts.get("file-0").toString().includes("original note"));
}

{
  const { instance, texts } = setup([{ id: "Notes/missing.md", path: "Notes/missing.md", content: body, sync_uuid: uuid }], [{ path: "Notes/other.md", content: body }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.missingInVault, 1);
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
  const { instance, rows, texts } = setup([{ id: "Notes/example.md", path: "Notes/example.md", content: body, sync_uuid: uuid }], [{ path: "Notes/example.md", content: existing }]);
  const result = await instance.reconcileExistingNoteIds();
  assert.equal(result.alreadyAligned, 1);
  assert.equal(result.changed, 0);
  assert.equal(rows[0].sync_uuid, uuid2, "An existing Vault identity must be preserved");
  assert.equal(texts.get("file-0").toString(), existing);
}

console.log("Safe existing-note ID recovery tests passed.");
