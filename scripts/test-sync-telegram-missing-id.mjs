import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Behavioral tests for the missing-frontmatter-id automation (Issue #107
// follow-up): Telegram files whose frontmatter has no valid id are classified
// and, only when the legacy filename suffix identifies exactly one D1 row and
// the body matches that row (ignoring id lines), the expected UUID is written
// into the frontmatter and the file is renamed to the slug name. Everything
// ambiguous is reported and left untouched (fail-closed). Applying is gated
// by the TELEGRAM_MISSING_ID_AUTOFILL worker variable (default off).
// Extracted from the Worker bundle like test-sync-telegram-rename.mjs.

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async backfillTelegramMissingIds(apply, limit) {");
const end = source.indexOf("async createTelegramNotes(apply, limit) {", start);
assert.ok(start >= 0 && end > start, "Could not extract backfillTelegramMissingIds");
const methods = source.slice(start, end).trim();

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
const MAX_NOTE_CHARS = 500000;
const deps = { YMap, YText, readUuid, isValidSyncUuid, deterministicUuid, sha256Hex, norm, __name, RESERVED_ROOT, WORKER_DEVICE, MIN_VAULT_FILES_FOR_WRITE, MAX_NOTE_CHARS };
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + methods + "\n}")(...Object.values(deps));

const TG_DIR = RESERVED_ROOT + "/Telegram/";
const NOTE_ID = "tg:8913169731:9100002001";
const NOTE_HASH16 = (await sha256Hex(NOTE_ID)).slice(0, 16);
const CONTENT_UUID = "333e4567-e89b-42d3-a456-426614174003";
const LEGACY_PATH = TG_DIR + `Shopping-List-${NOTE_HASH16}.md`;
const NEW_PATH = TG_DIR + "Shopping-List.md";
const withId = (uuid, body) => `---\nid: "${uuid}"\n---\n\n${body}`;
const rowFor = (id, content, deleted_at = null) => ({ id, content, deleted_at });

function makeInstance(doc, rows = [], autofill = "true") {
  const instance = new TestDO();
  instance.doc = doc;
  instance.pullVault = async (callback) => {
    if (callback) callback(doc);
    return doc;
  };
  instance.env = {
    TELEGRAM_MISSING_ID_AUTOFILL: autofill,
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

// --- (b) dry-run: candidate is reported with its classification, nothing changes ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk"))]).backfillTelegramMissingIds(false, 10);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.scanned, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.actions, [{ id: NOTE_ID, from: LEGACY_PATH, to: NEW_PATH, uuid: CONTENT_UUID }]);
  assert.deepEqual(result.skipped, []);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH, "dry-run must not rename");
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "buy milk", "dry-run must not edit the body");
  assert.equal(doc.getMap("pathToId").get(LEGACY_PATH), "legacy");
}

// --- (b) apply: id is backfilled, the file is renamed, the rest of the body is identical ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "buy milk\nsecond line");
  const instance = makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk\nsecond line"))]);
  const result = await instance.backfillTelegramMissingIds(true, 10);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.backfilledCount, 1);
  assert.equal(result.verified, 1);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), NEW_PATH);
  assert.equal(doc.getMap("pathToId").has(LEGACY_PATH), false);
  assert.equal(doc.getMap("pathToId").get(NEW_PATH), "legacy");
  const text = doc.getMap("idToText").get("legacy").toString();
  assert.equal(text, withId(CONTENT_UUID, "buy milk\nsecond line"), "only the frontmatter id line is added");
  // Idempotent: a second run no longer sees the file as a target and changes nothing.
  const again = await instance.backfillTelegramMissingIds(true, 10);
  assert.equal(again.scanned, 0);
  assert.equal(again.alreadyHasId, 1);
  assert.equal(again.candidates, 0);
  assert.equal(again.applied, false);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), text);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), NEW_PATH);
}

// --- (b) apply: a D1 row without a frontmatter id yields the deterministic UUID ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "plain body");
  const expected = await deterministicUuid(NOTE_ID);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "plain body")]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.backfilledCount, 1);
  assert.equal(result.verified, 1);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), withId(expected, "plain body"));
  assert.equal(doc.getMap("meta").get("legacy").get("path"), NEW_PATH);
}

// --- (b) apply: existing frontmatter keys are preserved, only the id line is added ---
{
  const doc = seedVault();
  const fileBody = "---\ntitle: Hello\n---\n\nbody text";
  const rowBody = `---\nid: "${CONTENT_UUID}"\ntitle: Hello\n---\n\nbody text`;
  addFile(doc, "legacy", LEGACY_PATH, fileBody);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, rowBody)]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.backfilledCount, 1);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), rowBody);
}

// --- flag gate: apply requested while the flag is off degrades to a dry-run report ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk"))], "false").backfillTelegramMissingIds(true, 10);
  assert.equal(result.flagEnabled, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.candidates, 1, "classification is still reported");
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "buy milk");
}

// --- (d) content mismatch: reported, never modified ---
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "edited in Obsidian");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk"))]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.equal(result.applied, false);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["content_mismatch"]);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "edited in Obsidian");
}

// --- (d) no D1 row behind the suffix / ambiguous rows / deleted row ---
{
  const doc = seedVault();
  addFile(doc, "orphan", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, []).backfillTelegramMissingIds(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["d1_note_not_found"]);
  assert.equal(result.candidates, 0);
}
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const rows = [rowFor(NOTE_ID, "buy milk"), rowFor(NOTE_ID, "buy milk")];
  const result = await makeInstance(doc, rows).backfillTelegramMissingIds(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["d1_match_ambiguous"]);
  assert.equal(result.candidates, 0);
}
{
  const doc = seedVault();
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk", "2026-10-20T00:00:00.000Z")]).backfillTelegramMissingIds(true, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["d1_row_deleted"]);
  assert.equal(result.candidates, 0);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "buy milk");
}

// --- (d) two no-id files sharing one suffix: both are ambiguous ---
{
  const doc = seedVault();
  addFile(doc, "one", TG_DIR + `First-${NOTE_HASH16}.md`, "buy milk");
  addFile(doc, "two", TG_DIR + `Second-${NOTE_HASH16}.md`, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["duplicate_filename_suffix", "duplicate_filename_suffix"]);
}

// --- (d) the slug target is already occupied: no ordinal is invented ---
{
  const doc = seedVault();
  addFile(doc, "occupier", NEW_PATH, withId("444e4567-e89b-42d3-a456-426614174004", "someone else"));
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk"))]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["target_exists"]);
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
}

// --- (d) the expected UUID already lives on another Vault file (conflict copy) ---
{
  const doc = seedVault();
  addFile(doc, "copy", TG_DIR + "Shopping-List (conflict).md", withId(CONTENT_UUID, "buy milk"));
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, withId(CONTENT_UUID, "buy milk"))]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["uuid_already_in_vault"]);
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "buy milk");
}

// --- (d) no suffix to identify by, and tombstones are reported but untouched ---
{
  const doc = seedVault();
  addFile(doc, "fresh", TG_DIR + "Brand-New.md", "written directly in Obsidian");
  const result = await makeInstance(doc, []).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["unmatched_no_suffix"]);
  assert.equal(doc.getMap("idToText").get("fresh").toString(), "written directly in Obsidian");
}
{
  const doc = seedVault();
  addFile(doc, "gone", LEGACY_PATH, "deleted body", true);
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "deleted body")]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["deleted_file"]);
  assert.equal(doc.getMap("meta").get("gone").get("path"), LEGACY_PATH);
  assert.equal(doc.getMap("idToText").get("gone").toString(), "deleted body");
}

// --- guard: an implausibly small vault is never written to ---
{
  const doc = new Doc();
  doc.getMap("sys").set("initialized", true);
  doc.getMap("sys").set("schemaVersion", 2);
  addFile(doc, "legacy", LEGACY_PATH, "buy milk");
  const result = await makeInstance(doc, [rowFor(NOTE_ID, "buy milk")]).backfillTelegramMissingIds(true, 10);
  assert.equal(result.ok, false);
  assert.equal(result.error, "vault_looks_empty");
  assert.equal(doc.getMap("meta").get("legacy").get("path"), LEGACY_PATH);
}

console.log("sync-telegram-missing-id: all assertions passed");
