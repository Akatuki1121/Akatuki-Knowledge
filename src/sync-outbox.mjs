// D1-backed event outbox for syncing knowledge notes with YAOS.
import { describeSafeFailure } from "./log-sanitize.mjs";
// Dependencies are injected so the queue can be tested independently of the Worker entry point.
export function createSyncOutbox({ readUuid, isValidSyncUuid, deterministicUuid }) {
async function enqueueSyncJob(env, entityType, entityId, operation, options = {}) {
  if (!env.DB || !["notes", "telegram_notes"].includes(entityType) || !["upsert", "delete"].includes(operation)) return;
  try {
    const row = entityType === "notes"
      ? await env.DB.prepare("SELECT id, path, title, content, content_hash, deleted_at, sync_uuid FROM notes WHERE id = ?").bind(entityId).first()
      : await env.DB.prepare("SELECT id, title, content, content_hash, deleted_at FROM telegram_notes WHERE id = ?").bind(entityId).first();
    if (!row) return;
    const now = new Date().toISOString();
    let syncUuid = null;
    if (entityType === "notes") {
      const contentUuid = readUuid(row.content);
      syncUuid = isValidSyncUuid(contentUuid) ? contentUuid : (isValidSyncUuid(row.sync_uuid) ? row.sync_uuid : await deterministicUuid("notes:" + row.id));
      if (row.sync_uuid !== syncUuid) await env.DB.prepare("UPDATE notes SET sync_uuid = ? WHERE id = ?").bind(syncUuid, row.id).run();
    } else {
      syncUuid = await deterministicUuid(row.id);
    }
    const previousRevision = entityType === "notes"
      ? await env.DB.prepare("SELECT content FROM note_revisions WHERE note_id = ? ORDER BY revision_id DESC LIMIT 1").bind(entityId).first()
      : await env.DB.prepare("SELECT content FROM telegram_note_revisions WHERE note_id = ? ORDER BY revision_id DESC LIMIT 1").bind(entityId).first();
    const payload = { id: row.id, path: row.path ?? null, title: row.title ?? "", content: row.content ?? "", contentHash: row.content_hash ?? null, syncUuid, deletedAt: row.deleted_at ?? null, expectedPreviousContent: previousRevision?.content ?? null, allowRestore: options.allowRestore === true };
    // Archive state is authoritative; preserve each event's baseline so updates can be conflict-checked in order.
    const effectiveOperation = row.deleted_at ? "delete" : operation;
    await env.DB.prepare("INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)").bind(crypto.randomUUID(), entityType, entityId, effectiveOperation, JSON.stringify(payload), now, now, now).run();
  } catch (error) {
    console.error("sync outbox enqueue failed", JSON.stringify(describeSafeFailure("sync_outbox_enqueue_failed", error)));
    throw new Error("sync_outbox_enqueue_failed");
  }
}
async function backfillSyncUuidIndex(env, limit = 100) {
  if (!env.DB) return { ok: false, skipped: "missing_binding" };
  let rows;
  try {
    rows = (await env.DB.prepare("SELECT id, content, sync_uuid FROM notes WHERE sync_uuid IS NULL ORDER BY id LIMIT ?").bind(Math.max(1, Math.min(200, limit))).all()).results || [];
  } catch {
    return { ok: false, skipped: "sync_uuid_migration_missing" };
  }
  let updated = 0;
  for (const row of rows) {
    const contentUuid = readUuid(row.content || "");
    const syncUuid = isValidSyncUuid(contentUuid) ? contentUuid : await deterministicUuid("notes:" + row.id);
    const result = await env.DB.prepare("UPDATE notes SET sync_uuid = ? WHERE id = ? AND sync_uuid IS NULL").bind(syncUuid, row.id).run();
    if (result.meta?.changes) updated++;
  }
  return { ok: true, scanned: rows.length, updated };
}
async function drainSyncOutbox(env, limit = 5) {
  if (!env.DB || !env.YJS_CLIENT) return { ok: false, skipped: "missing_binding" };
  const now = new Date().toISOString();
  let jobs;
  try {
    jobs = (await env.DB.prepare("SELECT j.job_id, j.entity_type, j.entity_id, j.operation, j.payload_json, j.attempts FROM yaos_sync_jobs j WHERE ((j.status = 'pending' AND j.next_attempt_at <= ?) OR (j.status = 'processing' AND j.lease_expires_at <= ?)) AND NOT EXISTS (SELECT 1 FROM yaos_sync_jobs earlier WHERE earlier.entity_type = j.entity_type AND earlier.entity_id = j.entity_id AND earlier.job_id < j.job_id AND earlier.status IN ('pending', 'processing')) ORDER BY j.created_at, j.job_id LIMIT ?").bind(now, now, Math.max(1, Math.min(20, limit))).all()).results;
  } catch {
    return { ok: false, skipped: "outbox_not_migrated" };
  }
  let sent = 0, failed = 0;
  for (const job of jobs) {
    const lease = new Date(Date.now() + 120000).toISOString();
    const claim = await env.DB.prepare("UPDATE yaos_sync_jobs SET status = 'processing', lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND lease_expires_at <= ?))").bind(lease, now, job.job_id, now, now).run();
    if (!claim.meta?.changes) continue;
    try {
      const response = await env.YJS_CLIENT.getByName("default").fetch(new Request("https://internal/knowledge-sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityType: job.entity_type, entityId: job.entity_id, operation: job.operation, payload: JSON.parse(job.payload_json) })
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true || result.verified !== true) throw new Error(result.error || ("yaos_sync_status_" + response.status));
      const finishedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE yaos_sync_jobs SET status = 'sent', sent_at = ?, updated_at = ?, lease_expires_at = NULL, last_error = NULL WHERE job_id = ? AND status = 'processing'").bind(finishedAt, finishedAt, job.job_id).run();
      sent++;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const permanent = ["vault_content_conflict", "ambiguous_sync_identity", "unsafe_path", "invalid_job", "invalid_payload"].some((code) => String(error).includes(code));
      const dead = attempts >= 8 || permanent;
      const next = new Date(Date.now() + Math.min(3600000, 1000 * (2 ** Math.min(attempts, 12)))).toISOString();
      const finishedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE yaos_sync_jobs SET status = ?, next_attempt_at = ?, updated_at = ?, lease_expires_at = NULL, last_error = ? WHERE job_id = ? AND status = 'processing'").bind(dead ? "dead" : "pending", next, finishedAt, String(error).slice(0, 500), job.job_id).run();
      failed++;
    }
  }
  return { ok: failed === 0, processed: jobs.length, sent, failed };
}

  return { enqueueSyncJob, backfillSyncUuidIndex, drainSyncOutbox };
}
