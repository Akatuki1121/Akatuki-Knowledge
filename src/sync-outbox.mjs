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
      if (isValidSyncUuid(row.sync_uuid)) {
        syncUuid = row.sync_uuid;
        if (isValidSyncUuid(contentUuid) && contentUuid !== syncUuid) throw new Error("sync_identity_conflict");
      } else if (isValidSyncUuid(contentUuid)) {
        const owners = (await env.DB.prepare("SELECT id FROM notes WHERE sync_uuid = ?").bind(contentUuid).all()).results || [];
        if (owners.some((owner) => owner.id !== row.id)) throw new Error("sync_identity_conflict");
        syncUuid = contentUuid;
      } else {
        syncUuid = crypto.randomUUID();
      }
      if (row.sync_uuid !== syncUuid) await env.DB.prepare("UPDATE notes SET sync_uuid = ? WHERE id = ? AND (sync_uuid IS NULL OR sync_uuid = ?)").bind(syncUuid, row.id, row.sync_uuid ?? "").run();
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
  let updated = 0, conflicts = 0;
  for (const row of rows) {
    const contentUuid = readUuid(row.content || "");
    let syncUuid = isValidSyncUuid(contentUuid) ? contentUuid : crypto.randomUUID();
    if (isValidSyncUuid(contentUuid)) {
      const owners = (await env.DB.prepare("SELECT id FROM notes WHERE sync_uuid = ?").bind(contentUuid).all()).results || [];
      if (owners.some((owner) => owner.id !== row.id)) {
        conflicts++;
        continue;
      }
    }
    const result = await env.DB.prepare("UPDATE notes SET sync_uuid = ? WHERE id = ? AND sync_uuid IS NULL").bind(syncUuid, row.id).run();
    if (result.meta?.changes) updated++;
  }
  return { ok: conflicts === 0, scanned: rows.length, updated, conflicts };
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
      const payload = JSON.parse(job.payload_json);
      if (job.entity_type === "notes") {
        if (!isValidSyncUuid(payload.syncUuid)) throw new Error("invalid_sync_uuid");
        // Deleting a note that was never present in YAOS is idempotent. There is
        // no stable fileId to map in that case; all successful upserts/restores
        // and deletes of known files still require a verified mapping.
        if (typeof result.fileId !== "string" || !result.fileId) {
          if (job.operation !== "delete") throw new Error("sync_identity_mapping_missing");
        } else {
          const existing = (await env.DB.prepare("SELECT file_id, sync_uuid, note_id, last_path FROM yaos_file_identity_map WHERE file_id = ? OR note_id = ? OR sync_uuid = ?")
            .bind(result.fileId, job.entity_id, payload.syncUuid).all()).results || [];
          if (existing.some((mapping) => mapping.file_id !== result.fileId || mapping.note_id !== job.entity_id || mapping.sync_uuid !== payload.syncUuid)) {
            throw new Error("sync_identity_mapping_conflict");
          }
          await env.DB.prepare("INSERT INTO yaos_file_identity_map (file_id, sync_uuid, note_id, last_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET last_path = excluded.last_path, updated_at = excluded.updated_at WHERE yaos_file_identity_map.note_id = excluded.note_id AND yaos_file_identity_map.sync_uuid = excluded.sync_uuid")
            .bind(result.fileId, payload.syncUuid, job.entity_id, payload.path || "", new Date().toISOString(), new Date().toISOString()).run();
          const verifiedMap = await env.DB.prepare("SELECT file_id, sync_uuid, note_id FROM yaos_file_identity_map WHERE file_id = ?").bind(result.fileId).first();
          if (!verifiedMap || verifiedMap.note_id !== job.entity_id || verifiedMap.sync_uuid !== payload.syncUuid) throw new Error("sync_identity_mapping_conflict");
        }
      }
      const finishedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE yaos_sync_jobs SET status = 'sent', sent_at = ?, updated_at = ?, lease_expires_at = NULL, last_error = NULL WHERE job_id = ? AND status = 'processing'").bind(finishedAt, finishedAt, job.job_id).run();
      sent++;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const permanent = ["vault_content_conflict", "ambiguous_sync_identity", "unsafe_path", "invalid_job", "invalid_payload", "sync_identity_conflict", "sync_identity_mapping_conflict", "sync_identity_mapping_missing", "invalid_sync_uuid"].some((code) => String(error).includes(code));
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
export async function listSyncOutboxJobs(env, options = {}) {
  if (!env?.DB) return { ok: false, error: "outbox_unavailable", jobs: [] };
  const allowedStatuses = new Set(["pending", "processing", "sent", "dead"]);
  const status = options.status;
  if (status !== undefined && !allowedStatuses.has(status)) return { ok: false, error: "invalid_status", jobs: [] };
  const limitValue = Number(options.limit ?? 50);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, Math.floor(limitValue))) : 50;
  const beforeValue = options.before === undefined ? null : Number(options.before);
  if (beforeValue !== null && (!Number.isSafeInteger(beforeValue) || beforeValue < 1)) return { ok: false, error: "invalid_cursor", jobs: [] };
  try {
    const clauses = [];
    const bindings = [];
    if (status) { clauses.push("status = ?"); bindings.push(status); }
    if (beforeValue !== null) { clauses.push("job_id < ?"); bindings.push(beforeValue); }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    bindings.push(limit + 1);
    const result = await env.DB.prepare("SELECT job_id, entity_type, entity_id, operation, status, attempts, next_attempt_at, lease_expires_at, last_error, created_at, updated_at, sent_at FROM yaos_sync_jobs" + where + " ORDER BY job_id DESC LIMIT ?").bind(...bindings).all();
    const jobs = result.results || [];
    const hasMore = jobs.length > limit;
    if (hasMore) jobs.pop();
    return { ok: true, jobs, nextBefore: hasMore ? jobs.at(-1)?.job_id ?? null : null };
  } catch {
    return { ok: false, error: "outbox_unavailable", jobs: [] };
  }
}

export async function retrySyncOutboxJob(env, jobId) {
  if (!env?.DB) return { ok: false, requeued: false, error: "outbox_unavailable" };
  if (!Number.isSafeInteger(jobId) || jobId < 1) return { ok: false, requeued: false, error: "invalid_job_id" };
  const now = new Date().toISOString();
  try {
    const result = await env.DB.prepare("UPDATE yaos_sync_jobs SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND status = 'dead'").bind(now, now, jobId).run();
    if (result.meta?.changes) return { ok: true, requeued: true, jobId, status: "pending", note: "attempts and last_error are preserved for diagnosis" };
    const existing = await env.DB.prepare("SELECT status FROM yaos_sync_jobs WHERE job_id = ?").bind(jobId).first();
    if (!existing) return { ok: false, requeued: false, error: "job_not_found" };
    return { ok: false, requeued: false, error: "job_not_dead", status: existing.status };
  } catch {
    return { ok: false, requeued: false, error: "outbox_unavailable" };
  }
}

