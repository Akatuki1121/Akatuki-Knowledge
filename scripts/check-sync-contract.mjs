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
  'allowRestore: options.allowRestore === true',
  'current?.deleted && !payload.allowRestore',
  'await enqueueSyncJob(env, table, id2, "upsert", { allowRestore: true })',
  'if (job.operation === "delete" || payload.deletedAt) {',
  'const incomingUuid = readUuid(content)',
  'SELECT id, path, sync_uuid, content_hash, title, content, deleted_at FROM notes WHERE path = ?',
  'SELECT id, path, sync_uuid, content_hash, title, content, deleted_at FROM notes WHERE sync_uuid = ?',
  'UPDATE notes SET path = ?, sync_uuid = ?, source_modified_at = ?, imported_at = ? WHERE id = ? AND deleted_at IS NULL',
  'UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?',
  'matches.some((note) => note.id !== previous.id)',
  'if (previous?.deleted_at)',
  'archivedSkipped++',
  'WHERE id = ? AND deleted_at IS NULL',
  'if (!previous && matches.length === 1)',
  'error: "ambiguous_sync_uuid"',
  'throw new Error("sync_outbox_enqueue_failed")',
  'entityType === "notes"',
  'SELECT id, title, content, content_hash, deleted_at FROM telegram_notes WHERE id = ?',
  'action === "knowledge-sync"',
  "async applyKnowledgeSyncJob(job)",
  'const contentUuid = readUuid(desiredContent)',
  'const uuid = isValidSyncUuid(contentUuid) ? contentUuid :',
  'const syncUuid = isSyncUuid ? incomingUuid :',
  'const verified = !verifiedItem || verifiedItem.deleted',
  'const verified = Boolean(verifiedItem && !verifiedItem.deleted',
  'current.value.set("deletedAt", now)',
  'const desiredUuid = readUuid(desiredContent);',
  'readUuid(textValue.toString()) === desiredUuid',
  'if (found.length > 1) throw new Error("ambiguous_sync_identity")',
  'const hasUuid = fm && /^id:\\s*',
  'pathToId = doc.getMap("pathToId")',
  'pathToId.set(desiredPath, fileId)',
  'pathToId.delete(current.path)',
  'current.deleted || pathChanged || indexChanged ? 1 : 0',
  'var PULL_CRON = "0 * * * *";',
  'await enqueueSyncJob(env, table, id2, "delete")',
  'await enqueueSyncJob(env, table, id2, "upsert")',
]) {
  assert.ok(source.includes(contract), "Missing source contract: " + contract);
}

assert.ok(!source.includes('SELECT id, path, title, content, deleted_at FROM " + entityType'), "Telegram notes do not have a path column");

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
