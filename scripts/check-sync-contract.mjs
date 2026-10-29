import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = (await readFile(new URL("../src/index.js", import.meta.url), "utf8")) + "\n" + (await readFile(new URL("../src/sync-outbox.mjs", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/0009_yaos_sync_jobs.sql", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/YAOS_EVENT_SYNC.md", import.meta.url), "utf8");

for (const contract of [
  "async function enqueueSyncJob",
  "async function drainSyncOutbox",
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
for (const [name, endMarker, batchCall] of [
  ["deleteNote", '__name(deleteNote, "deleteNote");', "await env.DB.batch(statements)"],
  ["restoreNote", '__name(restoreNote, "restoreNote");', "await env.DB.batch(restoreStatements)"],
  ["correctNote", '__name(correctNote, "correctNote");', "await env.DB.batch(statements)"]
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
assert.ok(docs.includes("migrations/0008_folders_schema_reconstructed.sql"));
console.log("Sync contract checks passed.");
