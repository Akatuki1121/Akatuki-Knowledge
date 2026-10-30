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

export async function getAgentTask(db, taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) return null;
  const row = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
    .bind(taskId.trim()).first();
  return presentTask(row);
}

export async function listAgentTasks(db, input = {}) {
  const status = typeof input.status === "string" ? input.status : "active";
  if (!["active", "terminal", "failed", "succeeded", "cancelled", "all"].includes(status)) {
    throw new TypeError("Unsupported task status filter");
  }
  const notifyChatId = typeof input.notifyChatId === "string" && input.notifyChatId.trim()
    ? input.notifyChatId.trim() : null;
  const limit = Math.max(1, Math.min(20, Math.floor(finiteNumber(input.limit, 10))));
  const result = await db.prepare(`
    SELECT task_id, task_type, status, attempts, max_attempts, created_at,
      updated_at, next_attempt_at, stop_reason, last_error_class,
      checkpoint_json, notify_chat_id, notification_status,
      notification_attempts, notification_last_error_class
    FROM agent_tasks
    WHERE (
      (? = 'active' AND status IN ('queued', 'running', 'waiting'))
      OR (? = 'terminal' AND status IN ('succeeded', 'failed', 'cancelled'))
      OR (? = 'failed' AND status = 'failed')
      OR (? = 'succeeded' AND status = 'succeeded')
      OR (? = 'cancelled' AND status = 'cancelled')
      OR (? = 'all')
    )
      AND (? IS NULL OR notify_chat_id = ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(
    status, status, status, status, status, status,
    notifyChatId, notifyChatId, limit,
  ).all();
  return (result?.results || []).map((row) => ({
    ...row,
    checkpoint: parseJson(row.checkpoint_json, {})
  }));
}



export async function expireAgentTasks(db, input = {}) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
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
  return Number(result?.meta?.changes || 0);
}

export async function listRecoverableAgentTasks(db, input = {}) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const now = toSqliteDateTime(nowMs);
  const limit = Math.max(1, Math.min(10, Math.floor(finiteNumber(input.limit, 5))));
  await expireAgentTasks(db, { nowMs });
  const result = await db.prepare(`
    SELECT task_id, status, next_attempt_at, lease_expires_at
    FROM agent_tasks
    WHERE status IN ('queued', 'waiting', 'running')
      AND budget_reserved = 1
      AND deadline_at > ?
      AND attempts < max_attempts
      AND ai_calls_used < max_ai_calls
      AND ai_tokens_used < max_ai_tokens
      AND (
        status = 'queued'
        OR (status = 'waiting' AND next_attempt_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )
    ORDER BY created_at
    LIMIT ?
  `).bind(now, now, now, limit).all();
  return result?.results || [];
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const payload = parseJson(payloadJson, null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object");
  }
  if (Object.hasOwn(payload, "inputHash")) {
    throw new TypeError("payload.inputHash is reserved");
  }
  const inputHash = await sha256Hex(payloadJson);
  const storedPayloadJson = safeJson({ ...payload, inputHash }, "payload");
  const taskId = input.taskId.trim();
  const notifyChatId = typeof input.notifyChatId === "string" && input.notifyChatId.trim()
    ? input.notifyChatId.trim() : null;
  // Cloudflare Workers Free includes 3,000 Workflow steps/day. Reserve at most
  // 2,700 here, leaving 300 steps for other account workloads and variance.
  // Each admitted task reserves 32 steps; there is no separate task-count cap.
  // Cloudflare Workers Free includes 3,000 Workflow steps/day. Reserve at most
  // 2,700 here, leaving 300 steps for other account workloads and variance.
  // Each admitted task reserves 32 steps; there is no separate task-count cap.
  const budgetDay = now.slice(0, 10);

  // D1 batch is transactional. The reservation ledger's unique task_id makes
  // retries safe even if an earlier implementation left an unreserved task.
  // The counted flag ensures the daily counters are incremented at most once.
  const statements = [
    db.prepare(`
      INSERT INTO agent_tasks (
        task_id, idempotency_key, task_type, status, budget_reserved, payload_json, checkpoint_json,
        attempts, max_attempts, ai_calls_used, max_ai_calls, ai_tokens_used, max_ai_tokens,
        created_at, updated_at, deadline_at, next_attempt_at,
        notify_chat_id, notification_status, notification_next_attempt_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, '{}', 0, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? IS NULL THEN 'none' ELSE 'pending' END, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).bind(
      taskId, idempotencyKey, input.taskType.trim(), storedPayloadJson,
      maxAttempts, maxAiCalls, maxAiTokens, now, now, deadline, now,
      notifyChatId, notifyChatId, now,
    ),
    db.prepare(`
      INSERT INTO agent_task_daily_budget (
        budget_day, tasks_reserved, workflow_steps_reserved, updated_at
      ) VALUES (?, 0, 0, ?)
      ON CONFLICT(budget_day) DO NOTHING
    `).bind(budgetDay, now),
    db.prepare(`
      INSERT INTO agent_task_budget_reservations (task_id, budget_day, workflow_steps, counted)
      SELECT task_id, ?, 32, 0
      FROM agent_tasks
      WHERE task_id = ? AND status = 'queued' AND budget_reserved = 0
        AND EXISTS (
          SELECT 1 FROM agent_task_daily_budget
          WHERE budget_day = ?
            AND workflow_steps_reserved + 32 <= 2700
        )
      ON CONFLICT(task_id) DO NOTHING
    `).bind(budgetDay, taskId, budgetDay),
    // Claim the reservation only while capacity is available. The intermediate
    // state prevents a retry from incrementing the daily counters twice.
    db.prepare(`
      UPDATE agent_task_budget_reservations
      SET counted = 1
      WHERE task_id = ? AND budget_day = ? AND counted = 0
        AND EXISTS (
          SELECT 1 FROM agent_task_daily_budget
          WHERE budget_day = ?
            AND workflow_steps_reserved + 32 <= 2700
        )
    `).bind(taskId, budgetDay, budgetDay),
    db.prepare(`
      UPDATE agent_task_daily_budget
      SET tasks_reserved = tasks_reserved + 1,
          workflow_steps_reserved = workflow_steps_reserved + 32,
          updated_at = ?
      WHERE budget_day = ?
        AND workflow_steps_reserved + 32 <= 2700
        AND EXISTS (
          SELECT 1 FROM agent_task_budget_reservations
          WHERE task_id = ? AND budget_day = ? AND counted = 1
        )
    `).bind(now, budgetDay, taskId, budgetDay),
    db.prepare(`
      UPDATE agent_task_budget_reservations
      SET counted = 2
      WHERE task_id = ? AND budget_day = ? AND counted = 1
    `).bind(taskId, budgetDay),
    db.prepare(`
      UPDATE agent_tasks
      SET budget_reserved = 1, updated_at = ?
      WHERE task_id = ? AND status = 'queued' AND budget_reserved = 0
        AND EXISTS (
          SELECT 1 FROM agent_task_budget_reservations
          WHERE task_id = ? AND counted = 2
        )
    `).bind(now, taskId, taskId),
  ];

  const results = await db.batch(statements);
  const inserted = Number(results?.[0]?.meta?.changes || 0) === 1;
  const row = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
    .bind(taskId).first();
  if (!row && idempotencyKey) {
    const existing = await db.prepare("SELECT * FROM agent_tasks WHERE idempotency_key = ?")
      .bind(idempotencyKey).first();
    if (existing) {
      const existingPayload = parseJson(existing.payload_json, null);
      if (!existingPayload || typeof existingPayload !== "object" || Array.isArray(existingPayload)) {
        throw new Error("idempotency_key_conflict");
      }
      const existingInputHash = typeof existingPayload.inputHash === "string"
        ? existingPayload.inputHash
        : await sha256Hex(safeJson(existingPayload, "payload"));
      if (existingInputHash !== inputHash) throw new Error("idempotency_key_conflict");
      return { created: false, task: presentTask(existing) };
    }
  }
  if (!row) throw new Error("agent_task_insert_not_confirmed");

  if (row.budget_reserved !== 1 && row.status === "queued") {
    await db.prepare(`
      UPDATE agent_tasks
      SET status = 'failed', stop_reason = 'daily_workflow_budget_exhausted',
          completed_at = ?, updated_at = ?
      WHERE task_id = ? AND budget_reserved = 0 AND status = 'queued'
    `).bind(now, now, taskId).run();
    throw new Error("daily_workflow_budget_exhausted");
  }
  if (row.budget_reserved !== 1 && row.status !== "queued") {
    return { created: inserted, task: presentTask(row) };
  }
  const admitted = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
    .bind(taskId).first();
  if (!admitted) throw new Error("agent_task_insert_not_confirmed");
  return { created: inserted, task: presentTask(admitted) };
}

/**
 * Cancel a task only when it belongs to the requesting Telegram chat and is
 * still active. Clearing the lease makes every in-flight checkpoint/completion
 * fail its conditional UPDATE, so a cancelled task cannot publish a result.
 */
export async function cancelAgentTask(db, input = {}) {
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  if (!taskId || !chatId) return { cancelled: false, reason: "not_found" };
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'cancelled', stop_reason = 'user_cancelled',
        completed_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL,
        notification_status = 'sent', notification_lease_expires_at = NULL
    WHERE task_id = ? AND notify_chat_id = ?
      AND status IN ('queued', 'running', 'waiting')
    RETURNING task_id
  `).bind(now, now, taskId, chatId).first();
  if (result?.task_id) return { cancelled: true, taskId: result.task_id };
  const task = await db.prepare("SELECT status, notify_chat_id FROM agent_tasks WHERE task_id = ?")
    .bind(taskId).first();
  if (!task || String(task.notify_chat_id ?? "") !== chatId) return { cancelled: false, reason: "not_found" };
  if (task.status === "cancelled") return { cancelled: false, reason: "already_cancelled" };
  return { cancelled: false, reason: "already_terminal", status: task.status };
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

  await expireAgentTasks(db, { nowMs });

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
      WHERE budget_reserved = 1
        AND (
        (status IN ('queued', 'waiting') AND next_attempt_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )
        AND deadline_at > ?
        AND attempts < max_attempts
        AND ai_calls_used < max_ai_calls
        AND ai_tokens_used < max_ai_tokens
        AND (? IS NULL OR task_id = ?)
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at
      LIMIT 1
    )
    RETURNING *
  `).bind(
    leaseToken, now, leaseSeconds, now, now, now, now, now,
    typeof input.taskId === "string" ? input.taskId : null,
    typeof input.taskId === "string" ? input.taskId : null,
  ).first();

  return presentTask(row);
}

/**
 * Reserve budget before issuing an AI request. The increment is atomic and the
 * call is charged even if the provider later fails, preventing retry loops from
 * making unbounded external requests.
 */
export async function reserveAgentAiBudget(db, input) {
  const estimatedTokens = Math.floor(finiteNumber(input.estimatedTokens, 0));
  if (estimatedTokens < 1 || estimatedTokens > TASK_BUDGET_CEILINGS.maxAiTokens) {
    throw new RangeError("estimatedTokens is outside the permitted range");
  }
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET ai_calls_used = ai_calls_used + 1,
        ai_tokens_used = ai_tokens_used + ?,
        updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND deadline_at > ?
      AND lease_expires_at > ?
      AND ai_calls_used < max_ai_calls
      AND ai_calls_used < ?
      AND ai_tokens_used + ? <= max_ai_tokens
      AND ai_tokens_used + ? <= ?
  `).bind(
    estimatedTokens, now, input.taskId, input.leaseToken, now, now,
    TASK_BUDGET_CEILINGS.maxAiCalls, estimatedTokens, estimatedTokens,
    TASK_BUDGET_CEILINGS.maxAiTokens,
  ).run();
  if (result?.meta?.changes === 1) return true;

  // If the lease is still ours, turn an exhausted budget into a terminal task
  // state instead of leaving a task that no executor can ever claim again.
  await db.prepare(`
    UPDATE agent_tasks
    SET status = 'failed',
        stop_reason = CASE
          WHEN deadline_at <= ? THEN 'task_deadline_exceeded'
          WHEN ai_calls_used >= max_ai_calls OR ai_calls_used >= ? THEN 'ai_call_budget_exhausted'
          ELSE 'ai_token_budget_exhausted'
        END,
        completed_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ?
      AND (
        deadline_at <= ?
        OR ai_calls_used >= max_ai_calls
        OR ai_calls_used >= ?
        OR ai_tokens_used + ? > max_ai_tokens
        OR ai_tokens_used + ? > ?
      )
  `).bind(
    now, now, now, input.taskId, input.leaseToken, now,
    now, TASK_BUDGET_CEILINGS.maxAiCalls, estimatedTokens, estimatedTokens,
    TASK_BUDGET_CEILINGS.maxAiTokens,
  ).run();
  return false;
}

/**
 * Replace the conservative per-call token reservation with provider usage.
 * When a provider returns no usage, callers deliberately leave the reservation
 * in place. A response-less provider failure settles estimated input tokens.
 */
export async function settleAgentAiBudget(db, input) {
  const reservedTokens = Math.floor(finiteNumber(input.reservedTokens, -1));
  const actualTokens = Math.floor(finiteNumber(input.actualTokens, -1));
  if (reservedTokens < 1 || actualTokens < 0 || actualTokens > TASK_BUDGET_CEILINGS.maxAiTokens) {
    throw new RangeError("AI token settlement is outside the permitted range");
  }
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET ai_tokens_used = ai_tokens_used - ? + ?, updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND deadline_at > ?
      AND ai_tokens_used >= ?
      AND ai_tokens_used - ? + ? <= max_ai_tokens
  `).bind(
    reservedTokens, actualTokens, now,
    input.taskId, input.leaseToken, now, now,
    reservedTokens, reservedTokens, actualTokens,
  ).run();
  return result?.meta?.changes === 1;
}

export async function renewAgentTaskLease(db, input) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const leaseToken = typeof input.leaseToken === "string" ? input.leaseToken : "";
  if (!leaseToken.trim()) throw new TypeError("leaseToken is required");
  const leaseSeconds = Math.max(5, Math.min(300, Math.floor(finiteNumber(input.leaseSeconds, 60))));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET lease_expires_at = datetime(?, '+' || ? || ' seconds'), updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND deadline_at > ?
  `).bind(now, leaseSeconds, now, input.taskId, leaseToken, now, now).run();
  return result?.meta?.changes === 1;
}

export async function saveAgentTaskCheckpoint(db, input) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const checkpointJson = safeJson(input.checkpoint, "checkpoint");
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET checkpoint_json = ?, updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND deadline_at > ?
  `).bind(checkpointJson, now, input.taskId, input.leaseToken, now, now).run();
  return result?.meta?.changes === 1;
}

export async function completeAgentTask(db, input) {
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'succeeded', completed_at = ?, updated_at = ?,
        lease_token = NULL, lease_expires_at = NULL, stop_reason = NULL
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND deadline_at > ?
  `).bind(now, now, input.taskId, input.leaseToken, now, now).run();
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
      AND lease_expires_at > ?
  `).bind(input.taskId, input.leaseToken, now).first();
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
          last_error_class = ?, last_error = ?, stop_reason = NULL,
          lease_token = NULL, lease_expires_at = NULL
      WHERE task_id = ? AND status = 'running' AND lease_token = ?
        AND lease_expires_at > ?
    `).bind(retryAt, now, input.errorClass ?? "unknown", safeErrorDetail(input.errorDetail), input.taskId, input.leaseToken, now).run();
    return { applied: result?.meta?.changes === 1, decision };
  }

  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'failed', completed_at = ?, updated_at = ?,
        last_error_class = ?, last_error = ?, stop_reason = ?,
        lease_token = NULL, lease_expires_at = NULL
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ?
  `).bind(now, now, input.errorClass ?? "unknown", safeErrorDetail(input.errorDetail), decision.stopReason, input.taskId, input.leaseToken, now).run();
  return { applied: result?.meta?.changes === 1, decision };
}

// Diagnostic text for a failed attempt. Callers pass an already redacted, content-free string; keep it short.
function safeErrorDetail(value) {
  return typeof value === "string" && value ? value.slice(0, 200) : null;
}
