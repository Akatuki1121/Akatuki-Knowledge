import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async stripFrontmatterIds(apply, limit) {");
const end = source.indexOf("\n  // 段階2a:", start);
assert.ok(start >= 0 && end > start, "Could not extract stripFrontmatterIds");
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
const readUuid = (content) => content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^id:\s*["']?([0-9a-f-]+)["']?\s*$/im)?.[1] ?? null;
const sha256Hex = async (value) => "hash:" + value.length;
const norm = (value) => String(value ?? "").normalize("NFC");
const RESERVED_ROOT = "Akatuki Knowledge";
const WORKER_DEVICE = "test-worker";
const MAX_SMALL_LIST = 30;
const deps = { YMap, YText, readUuid, sha256Hex, norm, RESERVED_ROOT, WORKER_DEVICE, MAX_SMALL_LIST, MIN_VAULT_FILES_FOR_WRITE: 1 };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + method + " }")(...Object.values(deps));
const guardDeps = { ...deps, MIN_VAULT_FILES_FOR_WRITE: 50 };
const GuardTestDO = new Function(...Object.keys(guardDeps), "return class GuardTestDO { " + method + " }")(...Object.values(guardDeps));

function setup(rows, vaultFiles, { initialized = true } = {}) {
  const revisions = [];
  const doc = new Doc();
  const meta = doc.getMap("meta"), texts = doc.getMap("idToText");
  if (initialized) doc.getMap("sys").set("initialized", true);
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
                  const [content, contentHash, updatedAt, id] = args;
                  const row = rows.find((item) => item.id === id);
                  if (row) Object.assign(row, { content, content_hash: contentHash, updated_at: updatedAt });
                  return { meta: { changes: row ? 1 : 0 } };
                }
                throw new Error("Unexpected SQL in test: " + sql);
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
  return { instance, doc, rows, texts, revisions };
}

const withId = `---\nid: "${uuid}"\ntags: ["#a"]\n---\n\nBody A`;
const idOnly = `---\nid: "${uuid}"\n---\n\nBody B`;
const noFm = "# Title\n\nBody C";
const fmNoId = `---\ntags: ["#b"]\n---\nBody D`;
const tgFile = `---\nid: "${uuid}"\n---\nTG body`;
const d1Only = `---\nid: "${uuid}"\n---\n\nD1 only body`;

function mixedSetup() {
  const rows = [
    { id: "Notes/with-id.md", path: "Notes/with-id.md", title: "With ID", content: withId, content_hash: "h1" },
    { id: "Notes/no-fm.md", path: "Notes/no-fm.md", title: "No FM", content: noFm, content_hash: "h2" },
    { id: "Notes/not-in-vault.md", path: "Notes/not-in-vault.md", title: "D1 only", content: d1Only, content_hash: "h3" }
  ];
  const vaultFiles = [
    { path: "Notes/with-id.md", content: withId },
    { path: "Notes/id-only.md", content: idOnly },
    { path: "Notes/no-fm.md", content: noFm },
    { path: "Notes/fm-no-id.md", content: fmNoId },
    { path: "Notes/deleted.md", content: idOnly, deleted: true },
    { path: "Akatuki Knowledge/Telegram/tg.md", content: tgFile },
    { path: "Notes/.hidden/secret.md", content: idOnly }
  ];
  return setup(rows, vaultFiles);
}

{
  const { instance, rows, texts } = mixedSetup();
  const result = await instance.stripFrontmatterIds(false, 100);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.vaultFiles, 5);
  assert.equal(result.targets, 3);
  assert.equal(result.lineRemoved, 1);
  assert.equal(result.blockRemoved, 2);
  assert.equal(result.reservedTargets, 1);
  assert.equal(result.skippedDeleted, 1);
  assert.equal(result.skippedHidden, 1);
  assert.equal(result.d1Scanned, 3);
  assert.equal(result.d1Targets, 2);
  assert.equal(result.applied, 0);
  assert.equal(texts.get("file-0").toString(), withId, "Dry-run must not modify Vault files");
  assert.equal(rows[0].content, withId, "Dry-run must not modify D1 rows");
}

{
  const { instance, rows, texts, revisions } = mixedSetup();
  const result = await instance.stripFrontmatterIds(true, 100);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.applied, 3);
  assert.equal(result.verified, 3);
  assert.deepEqual(result.unverified, []);
  assert.equal(result.d1Updated, 2);
  assert.equal(texts.get("file-0").toString(), `---\ntags: ["#a"]\n---\n\nBody A`, "Only the id line is removed; other frontmatter and the body stay");
  assert.equal(texts.get("file-1").toString(), "Body B", "An ID-only frontmatter block is removed entirely");
  assert.equal(texts.get("file-2").toString(), noFm);
  assert.equal(texts.get("file-3").toString(), fmNoId);
  assert.equal(texts.get("file-4").toString(), idOnly, "Tombstoned files are never rewritten");
  assert.equal(texts.get("file-5").toString(), "TG body");
  assert.equal(texts.get("file-6").toString(), idOnly, "Hidden-directory files are out of scope");
  for (const key of ["file-0", "file-1", "file-2", "file-3", "file-5"]) assert.equal(readUuid(texts.get(key).toString()), null, "No frontmatter ID may remain in a processed file");
  assert.equal(rows[0].content, `---\ntags: ["#a"]\n---\n\nBody A`, "The D1 copy loses its id line in the same operation");
  assert.equal(rows[1].content, noFm);
  assert.equal(rows[2].content, "D1 only body", "D1 rows without a Vault file are stripped too");
  assert.equal(revisions.length, 2, "Previous D1 contents are retained as revisions");

  const again = await instance.stripFrontmatterIds(true, 100);
  assert.equal(again.ok, true);
  assert.equal(again.targets, 0, "Stripping is idempotent");
  assert.equal(again.applied, 0);
  assert.equal(again.d1Targets, 0);
}

{
  const { instance, texts } = mixedSetup();
  const result = await instance.stripFrontmatterIds(true, 1);
  assert.equal(result.ok, true);
  assert.equal(result.targets, 3);
  assert.equal(result.selected, 1);
  assert.equal(result.applied, 1);
  assert.equal(readUuid(texts.get("file-0").toString()), null);
  assert.equal(readUuid(texts.get("file-1").toString()), uuid, "Files beyond the limit keep their ID for the next call");
}

{
  const crlf = `---\r\nid: "${uuid}"\r\ntags: ["#c"]\r\n---\r\nBody E`;
  const notFrontmatter = `# Head\n\n---\nid: "${uuid}"\n---\n`;
  const { instance, texts } = setup([], [{ path: "Notes/crlf.md", content: crlf }, { path: "Notes/rule.md", content: notFrontmatter }]);
  const result = await instance.stripFrontmatterIds(true, 100);
  assert.equal(result.ok, true);
  assert.equal(result.targets, 1, "A --- block that is not leading frontmatter is not touched");
  assert.equal(texts.get("file-0").toString(), `---\ntags: ["#c"]\n---\r\nBody E`);
  assert.equal(texts.get("file-1").toString(), notFrontmatter);
}

{
  const guarded = new GuardTestDO();
  const base = setup([], [{ path: "Notes/a.md", content: idOnly }, { path: "Notes/b.md", content: idOnly }]);
  guarded.env = base.instance.env;
  guarded.pullVault = base.instance.pullVault;
  const result = await guarded.stripFrontmatterIds(true, 100);
  assert.equal(result.skipped, "vault_looks_empty");
  assert.equal(result.vaultFiles, 2);
  assert.equal(base.texts.get("file-0").toString(), idOnly);
}

{
  const { instance } = setup([], [{ path: "Notes/a.md", content: idOnly }], { initialized: false });
  const result = await instance.stripFrontmatterIds(true, 100);
  assert.equal(result.skipped, "vault_not_initialized");
}

console.log("Frontmatter ID strip tests passed.");
