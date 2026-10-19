import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/pending/0008_yaos_sync_jobs.sql", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/YAOS_EVENT_SYNC.md", import.meta.url), "utf8");

for (const contract of [
  "async function enqueueSyncJob",
  "async function drainSyncOutbox",
  'action === "knowledge-sync"',
  "async applyKnowledgeSyncJob(job)",
  'var PULL_CRON = "0 * * * *";',
  'await enqueueSyncJob(env, "telegram_notes", id2, "upsert")',
  'await enqueueSyncJob(env, table, id2, "delete")',
  'await enqueueSyncJob(env, table, id2, "upsert")'
]) {
  assert.ok(source.includes(contract), "Missing source contract: " + contract);
}

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
