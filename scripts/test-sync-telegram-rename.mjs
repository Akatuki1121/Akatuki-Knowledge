import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Behavioral tests for the Telegram filename rename migration (step 2,
// Issue #107, method C): legacy files named "<slug>-<16 hex>.md" are renamed
// to "<slug>.md" only when the file's frontmatter id and the D1 row found via
// the filename suffix agree (double match, fail-closed otherwise). Only the
// filename and pathToId change; note bodies are never touched. Extracted
// from the Worker bundle like test-sync-telegram-identity.mjs.

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const renameStart = source.indexOf("async renameTelegramFiles(apply, limit) {");
const createStart = source.indexOf("async createTelegramNotes(apply, limit) {", renameStart);
assert.ok(renameStart >= 0 && createStart > renameStart, "Could not extract renameTelegramFiles");
const methods = source.slice(renameStart, createStart).trim();

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
  transact(fn) { fn(); }
}
const readUuid = (content) => String(content ?? "").slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
const isValidSyncUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
async function deterministicUuid(seed) {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = "89ab"[parseInt(digest[16], 16) & 3];
  return digest.slice(0, 8).join("") + "-" + digest.slice(8, 12).join("") + "-" + digest.slice(12, 16).join("") + "-" + digest.slice(16, 20).join("") + "-" + digest.slice(20, 32).join("");
}
async function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}
const norm = (value) => String(value ?? "").replaceAll("\\", "/").normalize("NFC");
const __name = (fn) => fn;
const RESERVED_ROOT = "Akatuki Knowledge";
const WORKER_DEVICE = "test-worker";
const MIN_VAULT_FILES_FOR_WRITE = 50;
const deps = { YMap, YText, readUuid, isValidSyncUuid, deterministicUuid, sha256Hex, norm, __name, RESERVED_ROOT, WORKER_DEVICE, MIN_VAULT_FILES_FOR_WRITE };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + methods + "\n}")(...Object.values(deps));

const TG_DIR = RESERVED_ROOT + "/Telegram/";
const NOTE_ID = "tg:8913169731:9100001001";
const NOTE_UUID = await deterministicUuid(NOTE_ID);
const NOTE_HASH16 = (await sha256Hex(NOTE_ID)).slice(0, 16);
const LEGACY_PATH = TG_DIR + `Shopping-List-${NOTE_HASH16}.md`;
const NEW_PATH = TG_DIR + "Shopping-List.md";
const withId = (uuid, body) => `---\nid: "${uuid}"\n---\n\n${body}`;
const rowFor = (id, content) => ({ id, content });

function makeInstance(doc, rows = [], pullVault) {
  const instance = new TestDO();
  instance.doc = doc;
  instance.pullVault = pullVault ?? (async (callback) => {
    if (callback) callback(doc);
    return doc;
  });
  instance.env = {
    DB: {
      prepare(sql) {
        assert.ok(sql.includes("FROM telegram_notes"), "Unexpected SQL: " + sql);
        return { async all() { return { results: rows }; } };
      }
    }
  };
  return instance;
}
function addFile(doc, fileId, path, content, deleted = false) {
  const value = new YMap();
  value.set("path", path);
  if (deleted) { value.set("deletedAt", Date.now()); value.set("deleted", true); }
  doc.getMap("meta").set(fileId, value);
  if (content !== null) doc.getMap("idToText").set(fileId, new YText(content));
  if (!deleted) doc.getMap("pathToId").set(path, fileId);
  return value;
}
function seedVault() {
  const doc = new Doc();
  doc.getMap("sys").set("initialized", true);
  doc.getMap("sys").set("schemaVersion", 2);
  for (let i = 0; i < MIN_VAULT_FILES_FOR_WRITE; i++) addFile(doc, `filler-${i}`, `Notes/filler-${i}.md`, "filler");
  return doc;
}

// --- dry-run (default): the candidate is reported but nothing changes ---
{
  const doc = seedVault();
  const body = withId(NOTE_UUID, "buy milk");
  addFile(doc, "legacy", LEGACY_PATH, body);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(false, 10);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.scanned, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.renames, [{ id: NOTE_ID, from: LEGACY_PATH, to: NEW_PATH, deleted: false }]);
  assert.deepEqual(result.skipped, []);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH, "dry-run must not rename");
  assert.equal(doc.getMap("pathToId").get(LEGACY_PATH), "legacy");
}

// --- apply: only meta.path and pathToId change; the body is byte-identical ---
{
  const doc = seedVault();
  const body = withId(NOTE_UUID, "buy milk\nsecond line");
  addFile(doc, "legacy", LEGACY_PATH, body);
  const instance = makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]);
  const result = await instance.renameTelegramFiles(true, 10);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.renamedCount, 1);
  assert.equal(result.verified, 1);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), NEW_PATH);
  assert.equal(doc.getMap("pathToId").has(LEGACY_PATH), false);
  assert.equal(doc.getMap("pathToId").get(NEW_PATH), "legacy");
  assert.equal(doc.getMap("idToText").get("legacy").toString(), body, "The body must not be touched");
  // Idempotent: a second run finds no legacy files at all.
  const again = await instance.renameTelegramFiles(true, 10);
  assert.equal(again.scanned, 0);
  assert.equal(again.candidates, 0);
  assert.equal(again.applied, false);
}

// --- apply: a tombstone is renamed as a tombstone (no resurrection, no index entry) ---
{
  const doc = seedVault();
  const body = withId(NOTE_UUID, "deleted body");
  const value = addFile(doc, "gone", LEGACY_PATH, body, true);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "deleted body")]).renameTelegramFiles(true, 10);
  assert.equal(result.renamedCount, 1);
  assert.equal(result.verified, 1);
  assert.equal(value.get("path"), NEW_PATH);
  assert.equal(value.get("deleted"), true, "A tombstone must stay a tombstone");
  assert.equal(doc.getMap("pathToId").has(NEW_PATH), false, "A tombstone must not gain a pathToId entry");
  assert.equal(doc.getMap("idToText").get("gone").toString(), body);
}

// --- fail-closed: frontmatter id does not match the D1 row behind the suffix ---
{
  const doc = seedVault();
  const otherUuid = await deterministicUuid("tg:8913169731:9999999999");
  addFile(doc, "legacy", LEGACY_PATH, withId(otherUuid, "someone else"));
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.equal(result.candidates, 0);
  assert.equal(result.applied, false);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["frontmatter_id_mismatch"]);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
}

// --- fail-closed: missing frontmatter id, and no D1 row behind the suffix ---
{
  const doc = seedVault();
  addFile(doc, "no-fm", LEGACY_PATH, "body without frontmatter");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["frontmatter_id_missing"]);
  assert.equal(result.candidates, 0);
}
{
  const doc = seedVault();
  addFile(doc, "orphan", LEGACY_PATH, withId(NOTE_UUID, "buy milk"));
  const result = await makeInstance(doc, []).renameTelegramFiles(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["d1_note_not_found"]);
  assert.equal(result.candidates, 0);
}

// --- fail-closed: a duplicated frontmatter id (YAOS conflict copy) blocks the rename ---
{
  const doc = seedVault();
  const body = withId(NOTE_UUID, "buy milk");
  addFile(doc, "legacy", LEGACY_PATH, body);
  addFile(doc, "conflict-copy", TG_DIR + "Shopping-List (conflict).md", body);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["duplicate_frontmatter_id"]);
  assert.equal(result.candidates, 0);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
}

// --- fail-closed: the target path is already occupied (no ordinal is invented) ---
{
  const doc = seedVault();
  const occupantBody = withId(await deterministicUuid("tg:8913169731:9100002002"), "occupant");
  addFile(doc, "occupant", NEW_PATH, occupantBody);
  addFile(doc, "legacy", LEGACY_PATH, withId(NOTE_UUID, "buy milk"));
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["target_exists"]);
  assert.equal(result.candidates, 0);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
  assert.equal(doc.getMap("idToText").get("occupant").toString(), occupantBody);
}

// --- two legacy files stripping to the same target: only the first (path order) is planned ---
{
  const doc = seedVault();
  const secondId = "tg:8913169731:9100001002";
  const secondUuid = await deterministicUuid(secondId);
  const secondHash16 = (await sha256Hex(secondId)).slice(0, 16);
  const secondLegacy = TG_DIR + `Shopping-List-${secondHash16}.md`;
  addFile(doc, "first", LEGACY_PATH, withId(NOTE_UUID, "first"));
  addFile(doc, "second", secondLegacy, withId(secondUuid, "second"));
  const rows = [rowFor(NOTE_ID, "first"), rowFor(secondId, "second")];
  const result = await makeInstance(doc, rows).renameTelegramFiles(true, 10);
  assert.equal(result.scanned, 2);
  assert.equal(result.candidates, 1, "The second file must not be planned onto the same target");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "target_already_planned");
  assert.equal(result.renamedCount, 1);
}

// --- the D1 content's own valid frontmatter UUID wins over the deterministic one (step 1 priority) ---
{
  const doc = seedVault();
  const customUuid = await deterministicUuid("custom-seed-for-" + NOTE_ID);
  const body = withId(customUuid, "custom id body");
  addFile(doc, "legacy", LEGACY_PATH, body);
  const rows = [rowFor(NOTE_ID, withId(customUuid, "custom id body"))];
  const result = await makeInstance(doc, rows).renameTelegramFiles(true, 10);
  assert.equal(result.candidates, 1);
  assert.equal(result.verified, 1);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), NEW_PATH);
}

// --- apply-time re-check: a target that appears after planning rejects the rename ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, withId(NOTE_UUID, "buy milk"));
  let calls = 0;
  const pullVault = async (callback) => {
    calls++;
    if (callback) {
      // Simulate another writer occupying the target between plan and apply.
      addFile(doc, "late-occupant", NEW_PATH, withId(await deterministicUuid("tg:1:2"), "late"));
      callback(doc);
    }
    return doc;
  };
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")], pullVault).renameTelegramFiles(true, 10);
  assert.equal(calls >= 2, true);
  assert.equal(result.renamedCount, 0);
  assert.deepEqual(result.rejected, [{ from: LEGACY_PATH, reason: "target_exists_since_plan" }]);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH, "A rejected rename must leave the file in place");
}

// --- apply-time re-check: a file whose path changed after planning is rejected ---
{
  const doc = seedVault();
  const value = addFile(doc, "legacy", LEGACY_PATH, withId(NOTE_UUID, "buy milk"));
  const pullVault = async (callback) => {
    if (callback) {
      value.set("path", TG_DIR + "moved-by-hand.md");
      callback(doc);
    }
    return doc;
  };
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")], pullVault).renameTelegramFiles(true, 10);
  assert.equal(result.renamedCount, 0);
  assert.deepEqual(result.rejected, [{ from: LEGACY_PATH, reason: "changed_since_plan" }]);
}

// --- limit: only the first `limit` candidates (path order) are renamed ---
{
  const doc = seedVault();
  const secondId = "tg:8913169731:9100001002";
  const secondUuid = await deterministicUuid(secondId);
  const secondHash16 = (await sha256Hex(secondId)).slice(0, 16);
  addFile(doc, "a-note", TG_DIR + `Alpha-${NOTE_HASH16}.md`, withId(NOTE_UUID, "alpha"));
  addFile(doc, "b-note", TG_DIR + `Beta-${secondHash16}.md`, withId(secondUuid, "beta"));
  const rows = [rowFor(NOTE_ID, "alpha"), rowFor(secondId, "beta")];
  const result = await makeInstance(doc, rows).renameTelegramFiles(true, 1);
  assert.equal(result.candidates, 2);
  assert.equal(result.selected, 1);
  assert.equal(result.renamedCount, 1);
  assert.equal(doc.getMap("meta").get("a-note").get("path"), TG_DIR + "Alpha.md");
  assert.equal(doc.getMap("meta").get("b-note").get("path"), TG_DIR + `Beta-${secondHash16}.md`);
}

// --- out of scope: legacy-looking files outside the Telegram folder are ignored ---
{
  const doc = seedVault();
  addFile(doc, "outside", `Notes/Shopping-List-${NOTE_HASH16}.md`, withId(NOTE_UUID, "buy milk"));
  addFile(doc, "already-new", NEW_PATH, withId(NOTE_UUID, "buy milk"));
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.equal(result.scanned, 0);
  assert.equal(result.candidates, 0);
}

// --- guards: uninitialized vault and a suspiciously empty vault refuse to run ---
{
  const doc = new Doc();
  for (let i = 0; i < MIN_VAULT_FILES_FOR_WRITE; i++) addFile(doc, `filler-${i}`, `Notes/filler-${i}.md`, "filler");
  const result = await makeInstance(doc, []).renameTelegramFiles(true, 10);
  assert.equal(result.ok, false);
  assert.equal(result.error, "vault_not_initialized");
}
{
  const doc = new Doc();
  doc.getMap("sys").set("initialized", true);
  doc.getMap("sys").set("schemaVersion", 2);
  addFile(doc, "only", LEGACY_PATH, withId(NOTE_UUID, "buy milk"));
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).renameTelegramFiles(true, 10);
  assert.equal(result.ok, false);
  assert.equal(result.error, "vault_looks_empty");
}

console.log("Sync telegram rename behavior tests passed.");
