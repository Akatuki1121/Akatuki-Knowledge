import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Behavioral tests for the Telegram note identity migration (step 3):
// frontmatter `id:` is the only identity key. The legacy filename suffix
// (-<16 hex chars of the note ID hash>) no longer matches anything, and new
// filenames carry no suffix. Extracted from the Worker bundle like
// test-sync-conflicts.mjs, with the production dependency implementations.

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const createStart = source.indexOf("async createTelegramNotes(apply, limit) {");
const applyStart = source.indexOf("async applyKnowledgeSyncJob(job) {", createStart);
const fetchStart = source.indexOf("\n  async fetch(request) {", applyStart);
assert.ok(createStart >= 0 && applyStart > createStart && fetchStart > applyStart, "Could not extract the Durable Object sync methods");
const methods = source.slice(createStart, applyStart).trim() + "\n" + source.slice(applyStart, fetchStart).trim();

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
const TestDO = new Function(...Object.keys(deps), "return class TestDO { " + methods + " }")(...Object.values(deps));

const TG_DIR = RESERVED_ROOT + "/Telegram/";
const NOTE_ID = "tg:8913169731:9100001001";
const NOTE_UUID = await deterministicUuid(NOTE_ID);
const NOTE_HASH16 = (await sha256Hex(NOTE_ID)).slice(0, 16);
const withId = (uuid, body) => `---\nid: "${uuid}"\n---\n\n${body}`;

function makeInstance(doc, rows = []) {
  const instance = new TestDO();
  instance.doc = doc;
  instance.pullVault = async (callback) => {
    if (callback) callback(doc);
    return doc;
  };
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
  doc.getMap("idToText").set(fileId, new YText(content));
  if (!deleted) doc.getMap("pathToId").set(path, fileId);
  return value;
}
function tgJob(id, title, content, extra = {}) {
  return {
    entityType: "telegram_notes", entityId: id, operation: "upsert",
    payload: { id, path: null, title, content, syncUuid: null, deletedAt: null, expectedPreviousContent: null, ...extra }
  };
}

// --- applyKnowledgeSyncJob: a new note is created without the hash suffix ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const job = tgJob(NOTE_ID, "Shopping List", "buy milk");
  job.payload.syncUuid = NOTE_UUID;
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(result.path, TG_DIR + "Shopping-List.md", "New Telegram files must not carry the hash suffix");
  const entries = [...doc.getMap("meta").values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].get("path"), TG_DIR + "Shopping-List.md");
  const text = [...doc.getMap("idToText").values()][0].toString();
  assert.equal(readUuid(text), NOTE_UUID, "The created file must carry the deterministic frontmatter id");
  assert.ok(text.endsWith("buy milk"));
}

// --- applyKnowledgeSyncJob: frontmatter match wins over the filename ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const vaultContent = withId(NOTE_UUID, "old body");
  addFile(doc, "file-1", TG_DIR + "renamed-by-hand.md", vaultContent);
  const job = tgJob(NOTE_ID, "Shopping List", "new body", { syncUuid: NOTE_UUID, expectedPreviousContent: vaultContent });
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(doc.getMap("meta").size, 1, "A renamed file must be updated in place, not duplicated");
  assert.equal(doc.getMap("meta").get("file-1").get("path"), TG_DIR + "Shopping-List.md");
  assert.equal(doc.getMap("idToText").get("file-1").toString(), withId(NOTE_UUID, "new body"));
}

// --- applyKnowledgeSyncJob: frontmatter match has priority over a legacy-suffix file ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const otherUuid = await deterministicUuid("tg:8913169731:9999999999");
  const decoy = withId(otherUuid, "decoy body");
  addFile(doc, "decoy", TG_DIR + `Shopping-List-${NOTE_HASH16}.md`, decoy);
  const mine = withId(NOTE_UUID, "old body");
  addFile(doc, "mine", TG_DIR + "anything.md", mine);
  const job = tgJob(NOTE_ID, "Shopping List", "new body", { syncUuid: NOTE_UUID, expectedPreviousContent: mine });
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(doc.getMap("idToText").get("mine").toString(), withId(NOTE_UUID, "new body"), "The frontmatter owner must be updated");
  assert.equal(doc.getMap("idToText").get("decoy").toString(), decoy, "A suffix-matching file with foreign frontmatter must stay untouched");
}

// --- applyKnowledgeSyncJob: a legacy-suffix file without frontmatter no longer matches (step 3) ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  addFile(doc, "legacy", TG_DIR + `Shopping-List-${NOTE_HASH16}.md`, "body text");
  const job = tgJob(NOTE_ID, "Shopping List", "body text", { syncUuid: NOTE_UUID });
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(result.path, TG_DIR + "Shopping-List.md");
  assert.equal(doc.getMap("meta").size, 2, "Without a frontmatter id the legacy file is not matched, so a new file is created");
  assert.equal(doc.getMap("meta").get("legacy").get("path"), TG_DIR + `Shopping-List-${NOTE_HASH16}.md`, "The unmatched legacy file stays untouched");
  assert.equal(doc.getMap("idToText").get("legacy").toString(), "body text", "The unmatched legacy file keeps its content");
  assert.equal(doc.getMap("pathToId").get(TG_DIR + "Shopping-List.md") !== "legacy", true);
  assert.equal(readUuid(doc.getMap("idToText").get(doc.getMap("pathToId").get(TG_DIR + "Shopping-List.md")).toString()), NOTE_UUID, "The newly created file carries the frontmatter id");
}

// --- applyKnowledgeSyncJob: tombstones are respected via frontmatter ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const value = addFile(doc, "gone", TG_DIR + "Shopping-List.md", withId(NOTE_UUID, "old body"), true);
  const result = await instance.applyKnowledgeSyncJob(tgJob(NOTE_ID, "Shopping List", "new body", { syncUuid: NOTE_UUID }));
  assert.equal(result.error, "vault_content_conflict", "A frontmatter-matched tombstone must not be resurrected");
  assert.equal(value.get("deleted"), true);
}
// --- applyKnowledgeSyncJob: a suffix-only tombstone is no longer detected (step 3) ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const value = addFile(doc, "gone", TG_DIR + `Shopping-List-${NOTE_HASH16}.md`, "old body", true);
  const result = await instance.applyKnowledgeSyncJob(tgJob(NOTE_ID, "Shopping List", "new body", { syncUuid: NOTE_UUID }));
  assert.equal(result.ok, true, "Without a frontmatter id the tombstone is not located, so the note is created fresh");
  assert.equal(result.path, TG_DIR + "Shopping-List.md");
  assert.equal(value.get("deleted"), true, "The undetected tombstone itself is left as-is");
  assert.equal(doc.getMap("meta").size, 2, "A new active file appears next to the undetected tombstone");
}

// --- applyKnowledgeSyncJob: slug collision gets a deterministic ordinal, never an overwrite ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const otherUuid = await deterministicUuid("tg:8913169731:9100002002");
  const otherContent = withId(otherUuid, "someone else's note");
  addFile(doc, "other", TG_DIR + "Shopping-List.md", otherContent);
  const job = tgJob(NOTE_ID, "Shopping List", "buy milk", { syncUuid: NOTE_UUID });
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(result.path, TG_DIR + "Shopping-List-2.md", "A colliding note must be placed at the first free ordinal path");
  assert.equal(doc.getMap("idToText").get("other").toString(), otherContent, "The occupying file must not be overwritten");
  assert.equal(doc.getMap("meta").get("other").get("path"), TG_DIR + "Shopping-List.md");
  const again = await instance.applyKnowledgeSyncJob(tgJob(NOTE_ID, "Shopping List", "buy milk", { syncUuid: NOTE_UUID, expectedPreviousContent: "buy milk" }));
  assert.equal(again.ok, true);
  assert.equal(again.path, TG_DIR + "Shopping-List-2.md", "Re-applying must stay on the ordinal path (identity comes from frontmatter)");
  assert.equal([...doc.getMap("meta").values()].filter((v) => String(v.get("path")).endsWith("-3.md")).length, 0, "No further ordinal file may appear");
}

// --- applyKnowledgeSyncJob: delete locates by frontmatter ---
{
  const doc = new Doc();
  const instance = makeInstance(doc);
  const value = addFile(doc, "file-1", TG_DIR + "Shopping-List.md", withId(NOTE_UUID, "buy milk"));
  const job = tgJob(NOTE_ID, "Shopping List", "buy milk", { syncUuid: NOTE_UUID });
  job.operation = "delete";
  const result = await instance.applyKnowledgeSyncJob(job);
  assert.equal(result.ok, true);
  assert.equal(value.get("deleted"), true);
  assert.equal(doc.getMap("pathToId").has(TG_DIR + "Shopping-List.md"), false);
}

// --- createTelegramNotes helpers ---
function seedVault() {
  const doc = new Doc();
  doc.getMap("sys").set("initialized", true);
  doc.getMap("sys").set("schemaVersion", 2);
  for (let i = 0; i < MIN_VAULT_FILES_FOR_WRITE; i++) addFile(doc, `filler-${i}`, `Notes/filler-${i}.md`, "filler");
  return doc;
}
const rowFor = (id, title, content) => ({ id, title, content });

// --- createTelegramNotes: existing notes are detected by frontmatter only (step 3) ---
{
  const doc = seedVault();
  addFile(doc, "by-uuid", TG_DIR + "renamed-by-hand.md", withId(NOTE_UUID, "body"));
  const secondId = "tg:8913169731:9100001002";
  const secondHash16 = (await sha256Hex(secondId)).slice(0, 16);
  addFile(doc, "by-suffix", TG_DIR + `Legacy-Title-${secondHash16}.md`, "body without frontmatter");
  const rows = [rowFor(NOTE_ID, "Shopping List", "body"), rowFor(secondId, "Legacy Title", "body without frontmatter")];
  const result = await makeInstance(doc, rows).createTelegramNotes(false, 10);
  assert.equal(result.ok, true);
  assert.equal(result.existing, 1, "Only the frontmatter match counts as existing");
  assert.equal(result.candidates, 1, "A legacy-suffix file without frontmatter id is not detected and becomes a candidate");
}

// --- createTelegramNotes: tombstoned notes are not recreated (frontmatter only, step 3) ---
{
  const doc = seedVault();
  addFile(doc, "gone-uuid", TG_DIR + "Shopping-List.md", withId(NOTE_UUID, "body"), true);
  const secondId = "tg:8913169731:9100001002";
  const secondHash16 = (await sha256Hex(secondId)).slice(0, 16);
  addFile(doc, "gone-suffix", TG_DIR + `Legacy-Title-${secondHash16}.md`, "body", true);
  const rows = [rowFor(NOTE_ID, "Shopping List", "body"), rowFor(secondId, "Legacy Title", "body")];
  const result = await makeInstance(doc, rows).createTelegramNotes(true, 10);
  assert.equal(result.tombstoned, 1, "Only the frontmatter tombstone is detected");
  assert.equal(result.candidates, 1, "The suffix-only tombstone is not detected, so its note is a candidate");
  assert.equal(result.createdCount, 1, "The undetected note is created fresh at the suffix-free path");
  const createdEntry = [...doc.getMap("meta").values()].find((v) => v.get("path") === TG_DIR + "Legacy-Title.md");
  assert.ok(createdEntry, "A new active file exists at the suffix-free path");
  assert.equal(createdEntry.get("deleted"), undefined, "The newly created file is not a tombstone");
  assert.equal(doc.getMap("meta").get("gone-suffix").get("deleted"), true, "The undetected tombstone itself is left as-is");
}

// --- createTelegramNotes: new files are suffix-free, carry frontmatter, and collisions get ordinals ---
{
  const doc = seedVault();
  const otherUuid = await deterministicUuid("tg:8913169731:9100002002");
  const otherContent = withId(otherUuid, "occupying note");
  addFile(doc, "other", TG_DIR + "Shopping-List.md", otherContent);
  const rows = [
    rowFor(NOTE_ID, "Shopping List", "first body"),
    rowFor("tg:8913169731:9100001003", "Shopping List", "second body"),
    rowFor("tg:8913169731:9100001004", "Fresh Title", "third body")
  ];
  const result = await makeInstance(doc, rows).createTelegramNotes(true, 10);
  assert.equal(result.ok, true);
  assert.equal(result.createdCount, 3);
  assert.equal(result.verified, 3);
  const paths = result.notes.map((n) => n.path).sort();
  assert.deepEqual(paths, [TG_DIR + "Fresh-Title.md", TG_DIR + "Shopping-List-2.md", TG_DIR + "Shopping-List-3.md"].sort(),
    "New files use the slug only; collisions resolve to deterministic ordinals without touching the occupant");
  assert.equal(doc.getMap("idToText").get("other").toString(), otherContent, "The occupying file must not be overwritten");
  const createdTexts = [...doc.getMap("idToText").entries()]
    .filter(([fileId]) => !fileId.startsWith("filler-") && fileId !== "other")
    .map(([, text]) => text.toString());
  assert.equal(createdTexts.length, 3);
  for (const text of createdTexts) assert.ok(isValidSyncUuid(readUuid(text)), "Every created file must carry a frontmatter id");
  assert.ok(createdTexts.some((text) => text.endsWith("first body") && readUuid(text) === NOTE_UUID));
}

console.log("Sync telegram identity behavior tests passed.");
