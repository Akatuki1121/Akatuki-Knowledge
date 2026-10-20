import { decideTaskRetry, TASK_BUDGET_CEILINGS } from "./background-task-policy.mjs";

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function toSqliteDateTime(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

function fromSqliteDateTime(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return Date.parse(normalized);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function presentTask(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload_json, {}),
    checkpoint: parseJson(row.checkpoint_json, {}),
  };
}

function safeJson(value, fieldName) {
  let serialized;
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    throw new TypeError(fieldName + " must be JSON serializable");
  }
  if (typeof serialized !== "string") throw new TypeError(fieldName + " must be JSON serializable");
  return serialized;
}

function boundedInteger(value, fallback, ceiling) {
  const number = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(ceiling, number));
}

export async function enqueueAgentTask(db, input) {
  if (!input || typeof input.taskId !== "string" || !input.taskId.trim()) {
    throw new TypeError("taskId is required");
  }
  if (typeof input.taskType !== "string" || !input.taskType.trim()) {
    throw new TypeError("taskType is required");
  }

  const nowMs = finiteNumber(input.nowMs, Date.now());
  const hardDeadline = nowMs + TASK_BUDGET_CEILINGS.maxTaskAgeMs;
  const deadlineAtMs = Math.min(finiteNumber(input.deadlineAtMs, hardDeadline), hardDeadline);
  if (deadlineAtMs <= nowMs) throw new RangeError("deadline must be in the future");

  const maxAttempts = boundedInteger(input.maxAttempts, 4, TASK_BUDGET_CEILINGS.maxAttempts);
  const maxAiCalls = boundedInteger(input.maxAiCalls, 20, TASK_BUDGET_CEILINGS.maxAiCalls);
  const maxAiTokens = boundedInteger(input.maxAiTokens, 40_000, TASK_BUDGET_CEILINGS.maxAiTokens);
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : null;
  const now = toSqliteDateTime(nowMs);
  const deadline = toSqliteDateTime(deadlineAtMs);
  const payloadJson = safeJson(input.payload, "payload");

  const result = await db.prepare(`
    INSERT INTO agent_tasks (
      task_id, idempotency_key, task_type, status, payload_json, checkpoint_json,
      attempts, max_attempts, ai_calls_used, max_ai_calls, ai_tokens_used, max_ai_tokens,
      created_at, updated_at, deadline_at, next_attempt_at
    ) VALUES (?, ?, ?, 'queued', ?, '{}', 0, ?, 0, ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).bind(
    input.taskId.trim(), idempotencyKey, input.taskType.trim(), payloadJson,
    maxAttempts, maxAiCalls, maxAiTokens, now, now, deadline, now,
  ).run();

  if (result?.meta?.changes === 0 && idempotencyKey) {
    const existing = await db.prepare(
      "SELECT * FROM agent_tasks WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first();
    if (existing) return { created: false, task: presentTask(existing) };
  }

  const row = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
    .bind(input.taskId.trim()).first();
  if (!row) throw new Error("agent_task_insert_not_confirmed");
  return { created: true, task: presentTask(row) };
}

/**
 * Claim one eligible task with a single atomic UPDATE ... RETURNING statement.
 * Concurrent executors cannot claim the same queued task. Expired leases are recoverable.
 */
export async function claimNextAgentTask(db, input = {}) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const now = toSqliteDateTime(nowMs);
  const leaseToken = typeof input.leaseToken === "string" ? input.leaseToken : "";
  if (!leaseToken.trim()) throw new TypeError("leaseToken is required");
  const leaseSeconds = Math.max(5, Math.min(300, Math.floor(finiteNumber(input.leaseSeconds, 60))));

  await db.prepare(`
    UPDATE agent_tasks
    SET status = 'failed',
        stop_reason = CASE
          WHEN deadline_at <= ? THEN 'task_deadline_exceeded'
          WHEN attempts >= max_attempts THEN 'attempt_budget_exhausted'
          WHEN ai_calls_used >= max_ai_calls THEN 'ai_call_budget_exhausted'
          ELSE 'ai_token_budget_exhausted'
        END,
        completed_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
    WHERE status IN ('queued', 'waiting', 'running')
      AND (
        deadline_at <= ?
        OR (
          (status IN ('queued', 'waiting') OR (status = 'running' AND lease_expires_at <= ?))
          AND (attempts >= max_attempts OR ai_calls_used >= max_ai_calls OR ai_tokens_used >= max_ai_tokens)
        )
      )
  `).bind(now, now, now, now, now).run();

  const row = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'running',
        attempts = attempts + 1,
        lease_token = ?,
        lease_expires_at = datetime(?, '+' || ? || ' seconds'),
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE task_id = (
      SELECT task_id FROM agent_tasks
      WHERE (
        (status IN ('queued', 'waiting') AND next_attempt_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )
        AND deadline_at > ?
        AND attempts < max_attempts
        AND ai_calls_used < max_ai_calls
        AND ai_tokens_used < max_ai_tokens
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at
      LIMIT 1
    )
    RETURNING *
  `).bind(leaseToken, now, leaseSeconds, now, now, now, now, now).first();

  return presentTask(row);
}

export async function saveAgentTaskCheckpoint(db, input) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const checkpointJson = safeJson(input.checkpoint, "checkpoint");
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET checkpoint_json = ?, updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
  `).bind(checkpointJson, now, input.taskId, input.leaseToken).run();
  return result?.meta?.changes === 1;
}

export async function completeAgentTask(db, input) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'succeeded', completed_at = ?, updated_at = ?,
        lease_token = NULL, lease_expires_at = NULL, stop_reason = NULL
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
  `).bind(now, now, input.taskId, input.leaseToken).run();
  return result?.meta?.changes === 1;
}

/**
 * Store only the classified error, never an arbitrary exception message that
 * could contain credentials or personal information.
 */
export async function recordAgentTaskFailure(db, input) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const now = toSqliteDateTime(nowMs);
  const row = await db.prepare(`
    SELECT * FROM agent_tasks
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
  `).bind(input.taskId, input.leaseToken).first();
  if (!row) return { applied: false, decision: null };

  const decision = decideTaskRetry({
    nowMs,
    createdAtMs: fromSqliteDateTime(row.created_at),
    deadlineAtMs: fromSqliteDateTime(row.deadline_at),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    aiCallsUsed: row.ai_calls_used,
    maxAiCalls: row.max_ai_calls,
    aiTokensUsed: row.ai_tokens_used,
    maxAiTokens: row.max_ai_tokens,
    errorClass: input.errorClass,
    retryable: input.retryable === true,
  });

  if (decision.action === "retry") {
    const retryAt = toSqliteDateTime(decision.retryAtMs);
    const result = await db.prepare(`
      UPDATE agent_tasks
      SET status = 'waiting', next_attempt_at = ?, updated_at = ?,
          last_error_class = ?, last_error = NULL, stop_reason = NULL,
          lease_token = NULL, lease_expires_at = NULL
      WHERE task_id = ? AND status = 'running' AND lease_token = ?
    `).bind(retryAt, now, input.errorClass, input.taskId, input.leaseToken).run();
    return { applied: result?.meta?.changes === 1, decision };
  }

  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'failed', completed_at = ?, updated_at = ?,
        last_error_class = ?, last_error = NULL, stop_reason = ?,
        lease_token = NULL, lease_expires_at = NULL
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
  `).bind(now, now, input.errorClass ?? "unknown", decision.stopReason, input.taskId, input.leaseToken).run();
  return { applied: result?.meta?.changes === 1, decision };
}
