import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async applyKnowledgeSyncJob(job) {");
const end = source.indexOf("\n  async fetch(request) {", start);
assert.ok(start >= 0 && end > start, "Could not extract applyKnowledgeSyncJob");
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
}
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const readUuid = (content) => content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^id:\s*["']?([0-9a-f-]+)["']?\s*$/im)?.[1] ?? null;
const isValidSyncUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const deterministicUuid = async (seed) => seed === "unused" ? uuid : uuid;
const norm = (value) => String(value ?? "").replaceAll("\\", "/").normalize("NFC");
const RESERVED_ROOT = ".yaos";
const WORKER_DEVICE = "test-worker";
const deps = { YMap, YText, readUuid, isValidSyncUuid, deterministicUuid, norm, RESERVED_ROOT, WORKER_DEVICE };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + method + " }")(...Object.values(deps));

function setup(content, path = "notes/example.md", deleted = false) {
  const doc = new Doc();
  const meta = doc.getMap("meta"), texts = doc.getMap("idToText"), paths = doc.getMap("pathToId");
  const value = new YMap();
  value.set("path", path);
  if (deleted) { value.set("deletedAt", Date.now()); value.set("deleted", true); }
  meta.set("file-id", value);
  texts.set("file-id", new YText(content));
  paths.set(path, "file-id");
  const instance = new TestDO();
  instance.doc = doc;
  instance.pullVault = async (callback) => {
    if (callback) callback(doc);
    return doc;
  };
  return { instance, doc, value, texts, paths };
}

const baseline = `---\nid: "${uuid}"\n---\n\noriginal`;
const desired = `---\nid: "${uuid}"\n---\n\nupdated by Akatuki Knowledge`;
const independentEdit = `---\nid: "${uuid}"\n---\n\nindependent Obsidian edit`;

{
  const { instance, texts } = setup(independentEdit);
  const result = await instance.applyKnowledgeSyncJob({
    entityType: "notes", entityId: "note-1", operation: "upsert",
    payload: { id: "note-1", path: "notes/example.md", title: "Example", content: desired, syncUuid: uuid, deletedAt: null, expectedPreviousContent: baseline }
  });
  assert.equal(result.error, "vault_content_conflict");
  assert.equal(result.applied, false);
  assert.equal(texts.get("file-id").toString(), independentEdit, "Conflicting Vault content must remain untouched");
}

{
  const { instance, texts } = setup(baseline);
  const result = await instance.applyKnowledgeSyncJob({
    entityType: "notes", entityId: "note-1", operation: "upsert",
    payload: { id: "note-1", path: "notes/example.md", title: "Example", content: desired, syncUuid: uuid, deletedAt: null, expectedPreviousContent: baseline }
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(texts.get("file-id").toString(), desired, "A clean baseline may be updated");
}

{
  const { instance, value, paths } = setup(independentEdit);
  const result = await instance.applyKnowledgeSyncJob({
    entityType: "notes", entityId: "note-1", operation: "upsert",
    payload: { id: "note-1", path: "notes/example.md", title: "Example", content: desired, syncUuid: uuid, deletedAt: "2026-10-19T00:00:00.000Z", expectedPreviousContent: baseline }
  });
  assert.equal(result.ok, true, "An archived D1 payload must be applied as a tombstone");
  assert.equal(value.get("deleted"), true);
  assert.equal(paths.has("notes/example.md"), false);
}

console.log("Sync conflict behavior tests passed.");
