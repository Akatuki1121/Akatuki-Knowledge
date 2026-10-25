const MAX_ATTEMPTS = 4;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

function iso(epochMs) {
  return new Date(epochMs).toISOString();
}

export async function enqueueAgentMemoryJob(db, input) {
  if (!input || typeof input.chatId !== "string" || !input.chatId.trim()
    || typeof input.messageId !== "string" || !input.messageId.trim()
    || typeof input.messageText !== "string" || !input.messageText.trim()
    || input.messageText.length > 50000) {
    throw new TypeError("Invalid agent memory job");
  }

  const now = iso(Number.isFinite(input.nowMs) ? input.nowMs : Date.now());
  const result = await db.prepare(`
    INSERT OR IGNORE INTO agent_memory_jobs (
      chat_id, message_id, message_text, status, attempts, max_attempts,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `).bind(input.chatId.trim(), input.messageId.trim(), input.messageText, MAX_ATTEMPTS, now, now, now).run();

  return { inserted: Number(result?.meta?.changes || 0) === 1 };
}

export async function claimNextAgentMemoryJob(db, input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const now = iso(nowMs);
  const leaseUntil = iso(nowMs + LEASE_MS);
  await db.prepare(`
    UPDATE agent_memory_jobs
    SET status = 'failed', last_error_class = 'attempt_budget_exhausted',
        lease_expires_at = NULL, message_text = '', completed_at = ?, updated_at = ?
    WHERE status IN ('queued', 'processing') AND attempts >= max_attempts
      AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(now, now, now).run();

  const row = await db.prepare(`
    UPDATE agent_memory_jobs
    SET status = 'processing', attempts = attempts + 1,
        lease_expires_at = ?, updated_at = ?
    WHERE job_id = (
      SELECT job_id FROM agent_memory_jobs
      WHERE attempts < max_attempts
        AND (
          (status = 'queued' AND next_attempt_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_memory_jobs active
          WHERE active.status = 'processing' AND active.lease_expires_at > ?
        )
      ORDER BY created_at, job_id
      LIMIT 1
    )
      AND attempts < max_attempts
      AND (
        (status = 'queued' AND next_attempt_at <= ?)
        OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_memory_jobs active
        WHERE active.status = 'processing' AND active.lease_expires_at > ?
      )
    RETURNING job_id, chat_id, message_id, message_text, attempts, max_attempts, created_at
  `).bind(leaseUntil, now, now, now, now, now, now, now).first();

  return row || null;
}

export async function completeAgentMemoryJob(db, jobId, nowMs = Date.now()) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new TypeError("Invalid agent memory job ID");
  const now = iso(nowMs);
  const result = await db.prepare(`
    UPDATE agent_memory_jobs
    SET status = 'completed', message_text = '', lease_expires_at = NULL,
        last_error_class = NULL, last_error_stage = NULL, last_error_detail = NULL,
        completed_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'processing'
  `).bind(now, now, jobId).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function failAgentMemoryJob(db, jobId, input = {}) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new TypeError("Invalid agent memory job ID");
  const row = await db.prepare(`
    SELECT attempts, max_attempts FROM agent_memory_jobs
    WHERE job_id = ? AND status = 'processing'
  `).bind(jobId).first();
  if (!row) return false;

  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const retryable = input.retryable === true && Number(row.attempts) < Number(row.max_attempts);
  const delayMs = Math.min(MAX_BACKOFF_MS, 30_000 * (2 ** Math.max(0, Number(row.attempts) - 1)));
  const now = iso(nowMs);
  const nextAttemptAt = iso(nowMs + delayMs);
  const errorClass = typeof input.errorClass === "string"
    ? input.errorClass.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64) || "unknown"
    : "unknown";
  // Stage is a code generated only from internal constants by the caller; sanitize it
  // with the same rule as errorClass and keep it NULL when absent.
  const errorStage = typeof input.errorStage === "string"
    ? input.errorStage.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64) || null
    : null;
  // Detail must already be sanitized by the caller (describeAgentTaskError); only cap it,
  // mirroring safeErrorDetail in background-task-store.mjs.
  const errorDetail = typeof input.errorDetail === "string" && input.errorDetail
    ? input.errorDetail.slice(0, 200)
    : null;

  const result = await db.prepare(`
    UPDATE agent_memory_jobs
    SET status = ?, next_attempt_at = ?, lease_expires_at = NULL,
        message_text = CASE WHEN ? = 'failed' THEN '' ELSE message_text END,
        last_error_class = ?, last_error_stage = ?, last_error_detail = ?,
        completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
        updated_at = ?
    WHERE job_id = ? AND status = 'processing'
  `).bind(retryable ? "queued" : "failed", nextAttemptAt,
    retryable ? "queued" : "failed", errorClass, errorStage, errorDetail,
    retryable ? "queued" : "failed", now, now, jobId).run();
  return Number(result?.meta?.changes || 0) === 1;
}
