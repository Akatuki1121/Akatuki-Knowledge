import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/pending/0008_yaos_sync_jobs.sql", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/YAOS_EVENT_SYNC.md", import.meta.url), "utf8");

for (const contract of [
  "async function enqueueSyncJob",
  "async function drainSyncOutbox",
  'const incomingUuid = readUuid(content)',
  'SELECT id, path, content_hash, title, content, deleted_at FROM notes',
  'matches.some((note) => note.id !== previous.id)',
  'if (!previous && matches.length === 1)',
  'UPDATE notes SET path = ?, source_modified_at = ?, imported_at = ?, deleted_at = NULL WHERE id = ?',
  'UPDATE notes SET path = ?, title = ?, content = ?, content_hash = ?',
  'error: "ambiguous_sync_uuid"',
  'throw new Error("sync_outbox_enqueue_failed")',
  'entityType === "notes"',
  'SELECT id, title, content, deleted_at FROM telegram_notes WHERE id = ?',
  'action === "knowledge-sync"',
  "async applyKnowledgeSyncJob(job)",
  'const uuidSeed = telegram ? payload.id : "notes:" + payload.id',
  'const uuid = digest.slice(0, 8).join("")',
  'const verified = !verifiedItem || verifiedItem.deleted',
  'const verified = Boolean(verifiedItem && !verifiedItem.deleted',
  'current.value.set("deletedAt", now)',
  'const uuidSeed = telegram ? payload.id : "notes:" + payload.id;',
  'const desiredUuid = readUuid(desiredContent);',
  'readUuid(textValue.toString()) === desiredUuid',
  'if (found.length > 1) throw new Error("ambiguous_sync_identity")',
  'const hasUuid = fm && /^id:\\s*',
  'pathToId = doc.getMap("pathToId")',
  'pathToId.set(desiredPath, fileId)',
  'pathToId.delete(current.path)',
  'current.deleted || pathChanged || indexChanged ? 1 : 0',
  'var PULL_CRON = "0 * * * *";',
  'await enqueueSyncJob(env, "telegram_notes", id2, "upsert")',
  'await enqueueSyncJob(env, table, id2, "delete")',
  'await enqueueSyncJob(env, table, id2, "upsert")',
  'await enqueueSyncJob(env, table, action.note_id, action.action_type === "create" ? "delete" : "upsert")',
  'await enqueueSyncJob(env, table, old.id, "upsert")'
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
assert.ok(docs.includes("migrations/pending/"));
console.log("Sync contract checks passed.");
