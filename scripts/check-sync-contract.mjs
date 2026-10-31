import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = (await readFile(new URL("../src/index.js", import.meta.url), "utf8")) + "\n" + (await readFile(new URL("../src/sync-outbox.mjs", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/0009_yaos_sync_jobs.sql", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/YAOS_EVENT_SYNC.md", import.meta.url), "utf8");

for (const contract of [
  "async function enqueueSyncJob",
  "async function drainSyncOutbox",
  "async function moveNote(request, url, env)",
  "async function getNoteByPath(url, env)",
  'request.method === "GET" && url.pathname.startsWith("/api/notes/")',
  "SELECT id, path, title, content, content_hash AS contentHash, sync_uuid AS syncUuid",
  'FROM notes WHERE path = ? AND deleted_at IS NULL',
  'const pathMatches = (await env.DB.prepare("SELECT id FROM notes WHERE path = ? AND deleted_at IS NULL LIMIT 2")',
  'error: "ambiguous_note_reference"',
  'const id2 = pathMatches.length === 1 ? pathMatches[0].id : reference',
  'SELECT (SELECT COUNT(*) FROM notes) + (SELECT COUNT(*) FROM telegram_notes) AS totalCount',
  'totalCount: Number(count?.totalCount || 0)',
  'nextCursor: hasMore ? results.at(-1)?.id || null : null',
  'url.pathname.startsWith("/api/notes/") && url.pathname.endsWith("/move")',
  'error: "same_note_path"',
  'error: "destination_note_exists"',
  'error: "content_hash_precondition_failed"',
  'error: "live_note_not_found"',
  'error: "sync_identity_mapping_conflict"',
  'body.expectedContentHash !== undefined',
  'url.pathname.endsWith("/move")',
  'SELECT id, path, title, content, content_hash, sync_uuid, deleted_at FROM notes WHERE path = ? AND deleted_at IS NULL',
  'SELECT file_id, sync_uuid, note_id, last_path FROM yaos_file_identity_map WHERE note_id = ? OR sync_uuid = ?',
  'UPDATE notes SET path = ? WHERE id = ? AND path = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM yaos_file_identity_map',
  'UPDATE yaos_file_identity_map SET last_path = ?, updated_at = ? WHERE file_id = ? AND note_id = ? AND sync_uuid = ? AND last_path = ? AND EXISTS (SELECT 1 FROM notes',
  'jobGuard: { checks: [["path", newPath], ["deleted_at", null]] }',
  'error: "destination_identity_mapping_conflict"',
  'error: "sync_identity_mapping_path_mismatch"',
  'if (!["deleted_at", "updated_at", "path"].includes(column)) throw new Error("invalid_job_guard")',
  "export async function listSyncOutboxJobs(env, options = {})",
  "export async function retrySyncOutboxJob(env, jobId)",
  "SELECT job_id, entity_type, entity_id, operation, status, attempts, next_attempt_at, lease_expires_at, last_error, created_at, updated_at, sent_at FROM yaos_sync_jobs",
  'SELECT status, COUNT(*) AS count FROM yaos_sync_jobs GROUP BY status',
  'outbox = { ok: true, ...counts }',
  'SELECT content FROM note_revisions WHERE note_id = ? ORDER BY revision_id DESC LIMIT 1',
  'SELECT content FROM telegram_note_revisions WHERE note_id = ? ORDER BY revision_id DESC LIMIT 1',
  'expectedPreviousContent: previousRevision?.content ?? null',
  "AND NOT EXISTS (SELECT 1 FROM yaos_sync_jobs earlier",
  "earlier.status IN ('pending', 'processing')",
  "const comparableContent = (value)",
  "let changedCount = 0, contentConflict = false",
  'error: "vault_content_conflict"',
  'const permanent = ["vault_content_conflict", "ambiguous_sync_identity", "unsafe_path", "invalid_job", "invalid_payload", "sync_identity_conflict", "sync_identity_mapping_conflict", "sync_identity_mapping_missing", "invalid_sync_uuid"]',

  'const effectiveOperation = row.deleted_at ? "delete" : operation;',
  'async function enqueueSyncJob(env, entityType, entityId, operation, options = {})',
  'async function prepareSyncJob(env, entityType, entityId, operation, options = {}, snapshot = null)',
  'enqueueSyncJob, prepareSyncJob, backfillSyncUuidIndex, drainSyncOutbox',
  'await prepareSyncJob(env, table, id2, "delete", { jobGuard: { checks: [["deleted_at", now]] } }, {',
  'await prepareSyncJob(env, table, id2, "upsert", { allowRestore: true, jobGuard: { checks: [["deleted_at", null], ["updated_at", now]] } }, {',
  'await prepareSyncJob(env, table, id2, "upsert", {}, {',
  "INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json, status, attempts, next_attempt_at, created_at, updated_at) SELECT ",
  'WHERE EXISTS (SELECT 1 FROM " + entityType + " WHERE "',
  'allowRestore: options.allowRestore === true',
  'current?.deleted && !payload.allowRestore',
  'if (job.operation === "delete" || payload.deletedAt) {',
  'const legacyId = readUuid(content)',
  'SELECT id, path, sync_uuid, content_hash, title, content, deleted_at FROM notes WHERE path = ?',
  'SELECT id, path, sync_uuid FROM notes WHERE sync_uuid = ?',
  'UPDATE notes SET path = ?, sync_uuid = ?, source_modified_at = ?, imported_at = ? WHERE id = ? AND deleted_at IS NULL',
  'UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?',
  'const identityMappings = !telegram',
  'if (previous?.deleted_at && !restorableArchived)',
  'body.vaultPull === true',
  'vault_pull_live_content_conflict',
  'archived_note_restore_verification_failed',
  'archivedSkipped++',
  'WHERE id = ? AND deleted_at IS NULL',
  'const observationComplete = body.observationComplete === true',
  'sync_identity_mapping_conflict',
  'throw new Error("sync_outbox_enqueue_failed")',
  'entityType === "notes"',
  'SELECT id, title, content, content_hash, deleted_at FROM telegram_notes WHERE id = ?',
  'action === "knowledge-sync"',
  "async applyKnowledgeSyncJob(job)",
  'const contentUuid = readUuid(desiredContent)',
  'uuid = isValidSyncUuid(payload.syncUuid) ? payload.syncUuid : null;',
  'const legacyId = readUuid(content);',
  'const verified = !verifiedItem || verifiedItem.deleted',
  'const verified = Boolean(verifiedItem && !verifiedItem.deleted',
  'current.value.set("deletedAt", now)',
  'const desiredUuid = telegram ? readUuid(desiredContent) : uuid;',
  'readUuid(textValue.toString()) === desiredUuid',
  'if (found.length > 1) throw new Error("ambiguous_sync_identity")',
  'const hasUuid = fm && /^id:\\s*',
  'pathToId = doc.getMap("pathToId")',
  'pathToId.set(desiredPath, fileId)',
  'pathToId.delete(current.path)',
  'current.deleted || pathChanged || indexChanged ? 1 : 0',
  'var PULL_CRON = "0 * * * *";',
  'var TASK_RECOVERY_CRON = "*/15 * * * *";',
  "function summarizeVaultPull(result, error, source)",
  "async function persistVaultPullDiagnostics(env, summary)",
  "async function readVaultPullDiagnostics(env)",
  "if (!apply) return { ...summary, applied: false, paths: data.notes.map((n) => n.path) };",
  "body: JSON.stringify({ notes: data.notes, observations: data.observations, observationComplete: data.observationComplete, vaultPull: true })",
  "'vault_pull_latest'",
  'summarizeVaultPull(result, null, "scheduled")',
  'summarizeVaultPull(result, null, "manual")',
  'summarizeVaultPull(result, error, "post_write")',
  "var POST_WRITE_DRAIN_BATCH_SIZE = 20;",
  "var POST_WRITE_DRAIN_MAX_BATCHES = 5;",
  "var POST_WRITE_PULL_COOLDOWN_MS = 120000;",
  '"vault_pull_post_write_last"',
  "async function pullAfterWrite(env, ctx, origin, sent)",
  "async function drainSyncOutboxAfterWrite(env, ctx, origin)",
  "await drainSyncOutbox(env, POST_WRITE_DRAIN_BATCH_SIZE)",
  "await pullAfterWrite(env, ctx, origin, sent)",
  "ctx.waitUntil(drainSyncOutboxAfterWrite(env, ctx, url.origin))",
  'const VAULT_FOSSIL_TARGETS = Object.freeze([',
  "function validateVaultFossilRemoval(input)",
  "function getVaultFossilTarget(path)",
  "function stripVaultFrontmatterId(content, expectedId)",
  'comparisonPath: "Notes/AI論/思考/AI とエコーチャンバー.md"',
  'vault_fossil_content_mismatch',
  'vault_fossil_comparison_note_unavailable',
  "async removeVaultFossilEntry(input)",
  'action === "remove-vault-fossil"',
  'url.pathname === "/sync/remove-vault-fossil" && request.method === "POST"',
  'error: "vault_fossil_hash_mismatch"',
  'error: "vault_fossil_not_found"',
  'error: "archived_note_precondition_failed"',
  "DELETE FROM yaos_file_identity_map WHERE note_id = ? OR file_id IN (?, ?)",
  "DELETE FROM yaos_sync_identity_review WHERE file_id IN (?, ?)",
  "body.dryRun === true",
  "SELECT file_id, path FROM yaos_sync_identity_review WHERE classification = 'needs_review' AND reason = 'vault_pull_live_content_conflict'",
  "DELETE FROM yaos_sync_identity_review WHERE file_id = ? AND reason = 'vault_pull_live_content_conflict'",
  "SELECT file_id FROM yaos_sync_identity_review WHERE classification = 'needs_review' AND reason = 'sync_identity_mapping_conflict'",
  "SELECT file_id, sync_uuid, note_id, last_path FROM yaos_file_identity_map WHERE file_id = ?",
  "DELETE FROM yaos_sync_identity_review WHERE file_id = ? AND reason = 'sync_identity_mapping_conflict'",
  "compatibleMappingPath = map.last_path === row.path || map.last_path === path",
  "await sha256(candidateInput.content) !== observation.contentHash",
  "hasMatchingDeadDelivery",
  "preserveVaultRevision",
  "previousRevisionContent: candidateInput.content",
  "reconciledConflicts",
  "reconciledRenames",
  "mapping.last_path !== currentPath && mapping.last_path !== newPath",
  "await drainSyncOutbox(env, Math.min(20, body.reconciledConflicts))",
  "identityConflicts, resolvedReviews, observationComplete",
  '"needsReview", "identityConflicts", "resolvedReviews"',
]) {
  assert.ok(source.includes(contract), "Missing source contract: " + contract);
}

// Note mutations and their outbox events are atomic: correction, delete, and
// restore prepare the event against a post-mutation snapshot BEFORE writing,
// then commit the mutation and the event in a single batch. The old
// post-commit enqueueSyncJob calls from those handlers must not return.
for (const retired of [
  'await enqueueSyncJob(env, table, id2, "delete")',
  'await enqueueSyncJob(env, table, id2, "upsert")',
  'await enqueueSyncJob(env, table, id2, "upsert", { allowRestore: true })'
]) {
  assert.ok(!source.includes(retired), "Retired non-atomic enqueue call must not return: " + retired);
}
function handlerSlice(name, endMarker) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, name + " handler must exist");
  return source.slice(start, end);
}
const deleteHandler = handlerSlice("deleteNote", '__name(deleteNote, "deleteNote");');
assert.ok(deleteHandler.indexOf("SELECT id FROM notes WHERE path = ? AND deleted_at IS NULL") < deleteHandler.indexOf("await locateNote(env, reference)"), "delete resolves current path before legacy ID");
assert.ok(deleteHandler.includes("ambiguous_note_reference"), "ambiguous path/ID references must fail closed");
const readHandler = handlerSlice("getNoteByPath", '__name(getNoteByPath, "getNoteByPath");');
assert.ok(readHandler.includes("FROM notes WHERE path = ? AND deleted_at IS NULL"), "note read is addressed by current path and excludes archived rows");
assert.ok(readHandler.includes("contentHash") && readHandler.includes("syncUuid") && readHandler.includes("content"), "note read returns body and manifest-style identity metadata");
const manifestHandler = handlerSlice("syncManifest", '__name(syncManifest, "syncManifest");');
assert.ok(manifestHandler.includes("totalCount") && manifestHandler.includes("nextCursor"), "manifest exposes total count and pagination cursor");
assert.ok(manifestHandler.includes("LIMIT ?") && manifestHandler.includes("limit + 1"), "manifest uses bounded keyset pagination");

for (const [name, endMarker, batchCall] of [
  ["deleteNote", '__name(deleteNote, "deleteNote");', "await env.DB.batch(statements)"],
  ["restoreNote", '__name(restoreNote, "restoreNote");', "await env.DB.batch(restoreStatements)"],
  ["correctNote", '__name(correctNote, "correctNote");', "await env.DB.batch(statements)"],
  ["moveNote", '__name(moveNote, "moveNote");', "await env.DB.batch(["]
]) {
  const handler = handlerSlice(name, endMarker);
  const prepareAt = handler.indexOf("await prepareSyncJob(");
  const batchAt = handler.indexOf(batchCall);
  assert.ok(prepareAt >= 0, name + " must prepare its outbox event before writing");
  assert.ok(batchAt > prepareAt, name + " must prepare the event before committing its batch");
  assert.ok(!handler.includes("enqueueSyncJob("), name + " must not enqueue after committing");
}

assert.ok(!source.includes('SELECT id, path, title, content, deleted_at FROM " + entityType'), "Telegram notes do not have a path column");
assert.ok(!source.includes("isHourlyCronTick"), "The hourly gate from the reverted 15-minute cron change must not return");
assert.ok(!source.includes('var PULL_CRON = "*/15 * * * *"'), "The scheduled pull stays hourly; prompt convergence comes from the post-write pull, not a faster cron");

for (const contract of [
  "CREATE TABLE yaos_sync_jobs",
  "UNIQUE",
  "lease_expires_at",
  "last_error",
  "idx_yaos_sync_jobs_ready",
  "idx_yaos_sync_jobs_entity",
  "idx_yaos_sync_jobs_lease"
]) {
  assert.ok(migration.includes(contract), "Missing migration contract: " + contract);
}

assert.ok(docs.includes("YAOS Worker and its Durable Object protocol unchanged"));
assert.ok(docs.includes("Identity-preserving note move API"));
assert.ok(docs.includes("notes.updated_at"));
assert.ok(docs.includes("migrations/0008_folders_schema_reconstructed.sql"));

function buildHandler(name, marker, globals) {
  const handler = handlerSlice(name, marker);
  return new Function(...Object.keys(globals), `return (${handler});`)(...Object.values(globals));
}
const jsonResult = (data, status = 200) => ({ data, status, ok: status < 400 });
const decodeRoute = (url) => {
  const prefix = "/api/notes/";
  return url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : null;
};
const normalizePath = (value) => value;
const movedNote = { id: "Notes/Old.md", path: "Notes/New.md", title: "Moved", content: "# Moved", content_hash: "a".repeat(64), sync_uuid: "11111111-1111-4111-8111-111111111111", ai_allowed: 1, review_state: "ready", deleted_at: null };
function makeDeleteDb(seed) {
  const state = structuredClone(seed);
  const db = {
    state,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() {
          if (sql.includes("SELECT id FROM notes WHERE path = ? AND deleted_at IS NULL LIMIT 2")) {
            return { results: state.notes.filter(n => n.path === values[0] && !n.deleted_at).slice(0, 2).map(n => ({ id: n.id })) };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT id, path, title, content, content_hash, sync_uuid, ai_allowed, review_state FROM notes")) {
            return state.notes.find(n => n.id === values[0] && !n.deleted_at) || null;
          }
          if (sql.includes("SELECT content FROM note_revisions")) return null;
          return null;
        },
        async run() {
          if (sql.includes("UPDATE notes SET deleted_at = ?")) {
            const note = state.notes.find(n => n.id === values[1] && !n.deleted_at);
            if (note) { note.deleted_at = values[0]; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 1 } };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return db;
}
const deleteBehavior = buildHandler("deleteNote", '__name(deleteNote, "deleteNote");', {
  json: jsonResult,
  noteIdFromRoute: decodeRoute,
  stableId: normalizePath,
  locateNote: async (env, id) => env.DB.state.notes.some(n => n.id === id && !n.deleted_at) ? "notes" : null,
  prepareSyncJob: async () => ({ statements: [] }),
  buildAgentMemorySuppressionStatements: () => []
});
for (const reference of ["Notes%2FNew.md", "Notes%2FOld.md"]) {
  const db = makeDeleteDb({ notes: [structuredClone(movedNote)] });
  const response = await deleteBehavior(new URL(`https://worker.test/api/notes/${reference}`), { DB: db });
  assert.equal(response.data.deleted, true, `DELETE by ${reference} should delete the moved note`);
  assert.ok(db.state.notes[0].deleted_at, "the addressed note should be archived");
}
const readBehavior = buildHandler("getNoteByPath", '__name(getNoteByPath, "getNoteByPath");', {
  json: jsonResult,
  noteIdFromRoute: decodeRoute,
  stableId: normalizePath,
  RESERVED_ROOT: "System"
});
const readResponse = await readBehavior(new URL("https://worker.test/api/notes/Notes%2FNew.md"), {
  DB: { prepare() { return { bind() { return this; }, async first() { return { id: movedNote.id, path: movedNote.path, title: movedNote.title, content: movedNote.content, contentHash: movedNote.content_hash, syncUuid: movedNote.sync_uuid, aiAllowed: 1, tagsJson: '["example"]' }; } }; } }
});
assert.equal(readResponse.data.note.content, movedNote.content, "path read returns the note body");
assert.equal(readResponse.data.note.contentHash, movedNote.content_hash, "path read returns the content hash");
const manifestBehavior = buildHandler("syncManifest", '__name(syncManifest, "syncManifest");', { json: jsonResult });
const manifestRows = Array.from({ length: 614 }, (_, index) => ({ id: `note-${String(index).padStart(4, "0")}`, source: "obsidian" }));
const manifestDb = { prepare(sql) { let values = []; return {
  bind(...args) { values = args; return this; },
  async all() { return { results: manifestRows.filter(row => row.id > values[0]).slice(0, values[2]) }; },
  async first() { return { totalCount: manifestRows.length }; }
}; } };
const gathered = [];
let cursor = "";
let totalCount = 0;
do {
  const page = await manifestBehavior(new URL(`https://worker.test/api/sync/manifest?limit=500&cursor=${encodeURIComponent(cursor)}`), { DB: manifestDb });
  gathered.push(...page.data.notes);
  cursor = page.data.nextCursor || "";
  totalCount = page.data.totalCount;
} while (cursor);
assert.equal(totalCount, manifestRows.length, "manifest reports total count");
assert.equal(gathered.length, manifestRows.length, "cursor pagination returns every row beyond the page limit");
assert.equal(new Set(gathered.map(row => row.id)).size, manifestRows.length, "manifest pages contain no duplicate IDs");

console.log("Sync contract checks passed.");
