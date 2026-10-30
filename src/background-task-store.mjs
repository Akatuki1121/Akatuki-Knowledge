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
          ELSE 'attempt_budget_exhausted'
        END,
        completed_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
    WHERE status IN ('queued', 'waiting', 'running')
      AND (
        deadline_at <= ?
        OR (
          (status IN ('queued', 'waiting') OR (status = 'running' AND lease_expires_at <= ?))
          AND attempts >= max_attempts
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
  const maxTaskAgeMs = boundedInteger(
    input.maxTaskAgeMs,
    TASK_BUDGET_CEILINGS.maxTaskAgeMs,
    TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs,
  );
  const hardDeadline = nowMs + maxTaskAgeMs;
  const deadlineAtMs = Math.min(finiteNumber(input.deadlineAtMs, hardDeadline), hardDeadline);
  if (deadlineAtMs <= nowMs) throw new RangeError("deadline must be in the future");

  const maxAttempts = boundedInteger(input.maxAttempts, 4, TASK_BUDGET_CEILINGS.maxAttempts);
  // Legacy columns remain for telemetry/schema compatibility; they are not limits.
  const maxAiCalls = Number.MAX_SAFE_INTEGER;
  const maxAiTokens = Number.MAX_SAFE_INTEGER;
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
      if (existing.status === "failed" && existing.stop_reason === "daily_workflow_budget_exhausted") {
        const retryAt = now;
        const deadline = toSqliteDateTime(nowMs + TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs);
        await db.prepare(`
          UPDATE agent_tasks
          SET status = 'queued', budget_reserved = 0, stop_reason = NULL, completed_at = NULL,
              next_attempt_at = ?, deadline_at = ?, updated_at = ?,
              lease_token = NULL, lease_expires_at = NULL
          WHERE task_id = ? AND status = 'failed' AND stop_reason = 'daily_workflow_budget_exhausted'
        `).bind(retryAt, deadline, now, existing.task_id).run();
        const requeued = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?").bind(existing.task_id).first();
        return { created: false, queuedForBudget: true, task: presentTask(requeued) };
      }
      return { created: false, task: presentTask(existing) };
    }
  }
  if (!row) throw new Error("agent_task_insert_not_confirmed");

  if (row.budget_reserved !== 1 && row.status === "queued") {
    const current = new Date(nowMs);
    const nextResetMs = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 1, 0);
    const retryAt = toSqliteDateTime(nextResetMs);
    const deadline = toSqliteDateTime(nextResetMs + 60 * 60 * 1000);
    await db.prepare(`
      UPDATE agent_tasks
      SET next_attempt_at = ?, deadline_at = CASE WHEN deadline_at < ? THEN ? ELSE deadline_at END,
          updated_at = ?
      WHERE task_id = ? AND budget_reserved = 0 AND status = 'queued'
    `).bind(retryAt, deadline, deadline, now, taskId).run();
    const deferred = await db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?").bind(taskId).first();
    return { created: inserted, queuedForBudget: true, task: presentTask(deferred) };
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
 * Reserve the next available daily Workflow capacity for queued tasks. Tasks
 * that do not fit remain queued and are deferred to the next UTC day.
 */
export async function reserveQueuedAgentTaskBudget(db, input = {}) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const now = toSqliteDateTime(nowMs);
  const current = new Date(nowMs);
  const budgetDay = now.slice(0, 10);
  const nextResetMs = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 1, 0);
  const retryAt = toSqliteDateTime(nextResetMs);
  const deadline = toSqliteDateTime(nextResetMs + 60 * 60 * 1000);

  try {
    await db.prepare(`
      INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at)
      VALUES (?, 0, 0, ?)
      ON CONFLICT(budget_day) DO NOTHING
    `).bind(budgetDay, now).run();

    const budget = await db.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?")
      .bind(budgetDay).first();
    if (!budget) return { reserved: 0, available: 0, reason: "budget_row_unavailable" };

    const available = Math.max(0, Math.min(
      Math.floor((2_700 - Number(budget.workflow_steps_reserved || 0)) / 32),
      90 - Number(budget.tasks_reserved || 0),
    ));
    if (available === 0) {
      await db.prepare(`
        UPDATE agent_tasks
        SET next_attempt_at = ?, deadline_at = CASE WHEN deadline_at < ? THEN ? ELSE deadline_at END,
            updated_at = ?
        WHERE status = 'queued' AND budget_reserved = 0 AND next_attempt_at <= ?
      `).bind(retryAt, deadline, deadline, now, now).run();
      return { reserved: 0, available: 0, nextAttemptAt: retryAt };
    }

    const candidates = (await db.prepare(`
      SELECT task_id
      FROM agent_tasks
      WHERE status = 'queued' AND budget_reserved = 0
        AND next_attempt_at <= ? AND deadline_at > ? AND attempts < max_attempts
      ORDER BY created_at ASC, task_id ASC
      LIMIT ?
    `).bind(now, now, available).all()).results || [];

    let reserved = 0;
    for (const candidate of candidates) {
      const taskId = candidate.task_id;
      const results = await db.batch([
        db.prepare(`
          INSERT INTO agent_task_budget_reservations (task_id, budget_day, workflow_steps, counted)
          SELECT task_id, ?, 32, 0 FROM agent_tasks
          WHERE task_id = ? AND status = 'queued' AND budget_reserved = 0
          ON CONFLICT(task_id) DO UPDATE SET
            budget_day = excluded.budget_day, workflow_steps = 32, counted = 0
          WHERE agent_task_budget_reservations.counted = 0
        `).bind(budgetDay, taskId),
        db.prepare(`
          UPDATE agent_task_budget_reservations
          SET counted = 1
          WHERE task_id = ? AND budget_day = ? AND counted = 0
            AND EXISTS (
              SELECT 1 FROM agent_task_daily_budget
              WHERE budget_day = ? AND tasks_reserved < 90
                AND workflow_steps_reserved + 32 <= 2700
            )
        `).bind(taskId, budgetDay, budgetDay),
        db.prepare(`
          UPDATE agent_task_daily_budget
          SET tasks_reserved = tasks_reserved + 1,
              workflow_steps_reserved = workflow_steps_reserved + 32,
              updated_at = ?
          WHERE budget_day = ? AND tasks_reserved < 90
            AND workflow_steps_reserved + 32 <= 2700
            AND EXISTS (
              SELECT 1 FROM agent_task_budget_reservations r
              JOIN agent_tasks t ON t.task_id = r.task_id
              WHERE r.task_id = ? AND r.budget_day = ? AND r.counted = 1
                AND t.status = 'queued' AND t.budget_reserved = 0
            )
        `).bind(now, budgetDay, taskId, budgetDay),
      ]);
      if (Number(results?.[2]?.meta?.changes || 0) !== 1) {
        await db.prepare("UPDATE agent_task_budget_reservations SET counted = 0 WHERE task_id = ? AND budget_day = ? AND counted = 1")
          .bind(taskId, budgetDay).run();
        break;
      }
      await db.batch([
        db.prepare("UPDATE agent_task_budget_reservations SET counted = 2 WHERE task_id = ? AND budget_day = ? AND counted = 1")
          .bind(taskId, budgetDay),
        db.prepare(`
          UPDATE agent_tasks
          SET budget_reserved = 1, next_attempt_at = ?, updated_at = ?
          WHERE task_id = ? AND status = 'queued' AND budget_reserved = 0
            AND EXISTS (
              SELECT 1 FROM agent_task_budget_reservations
              WHERE task_id = ? AND budget_day = ? AND counted = 2
            )
        `).bind(now, now, taskId, taskId, budgetDay),
      ]);
      reserved++;
    }

    const remaining = (await db.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?")
      .bind(budgetDay).first()) || {};
    const left = Math.max(0, Math.min(
      Math.floor((2_700 - Number(remaining.workflow_steps_reserved || 0)) / 32),
      90 - Number(remaining.tasks_reserved || 0),
    ));
    if (left === 0) {
      await db.prepare(`
        UPDATE agent_tasks
        SET next_attempt_at = ?, deadline_at = CASE WHEN deadline_at < ? THEN ? ELSE deadline_at END,
            updated_at = ?
        WHERE status = 'queued' AND budget_reserved = 0 AND next_attempt_at <= ?
      `).bind(retryAt, deadline, deadline, now, now).run();
    }
    return { reserved, available: left, scanned: candidates.length };
  } catch {
    return { reserved: 0, available: 0, reason: "workflow_budget_reservation_unavailable" };
  }
}

/**
 * Requeue tasks that an older Worker version incorrectly marked terminal when
 * the daily Workflow-step reservation was full.
 */
export async function requeueAgentTaskAfterBudgetWait(db, taskId, nowMs = Date.now()) {
  const now = toSqliteDateTime(nowMs);
  const retryAt = now;
  const deadline = toSqliteDateTime(nowMs + TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs);
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET status = 'queued', budget_reserved = 0, stop_reason = NULL, completed_at = NULL,
        next_attempt_at = ?, deadline_at = ?, updated_at = ?,
        lease_token = NULL, lease_expires_at = NULL
    WHERE task_id = ? AND status = 'failed' AND stop_reason = 'daily_workflow_budget_exhausted'
    RETURNING task_id
  `).bind(retryAt, deadline, now, taskId).first();
  return Boolean(result?.task_id);
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
 * Record estimated AI usage before the provider call. This is telemetry only:
 * it does not impose per-task call/token limits or replace Cloudflare's quota.
 */
export async function reserveAgentAiBudget(db, input) {
  const estimatedTokens = Math.floor(finiteNumber(input.estimatedTokens, 0));
  if (estimatedTokens < 1 || !Number.isSafeInteger(estimatedTokens)) {
    throw new RangeError("estimatedTokens must be a positive safe integer");
  }
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET ai_calls_used = ai_calls_used + 1,
        ai_tokens_used = ai_tokens_used + ?,
        updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND deadline_at > ? AND lease_expires_at > ?
  `).bind(
    estimatedTokens, now, input.taskId, input.leaseToken, now, now,
  ).run();
  return result?.meta?.changes === 1;
}

/**
 * Replace the conservative per-call token reservation with provider usage.
 * Counters are telemetry only and never reject an AI request or result.
 */
export async function settleAgentAiBudget(db, input) {
  const reservedTokens = Math.floor(finiteNumber(input.reservedTokens, -1));
  const actualTokens = Math.floor(finiteNumber(input.actualTokens, -1));
  if (reservedTokens < 1 || actualTokens < 0 || !Number.isSafeInteger(actualTokens)) {
    throw new RangeError("AI token settlement values must be non-negative safe integers");
  }
  const now = toSqliteDateTime(finiteNumber(input.nowMs, Date.now()));
  const result = await db.prepare(`
    UPDATE agent_tasks
    SET ai_tokens_used = MAX(0, ai_tokens_used - ?) + ?, updated_at = ?
    WHERE task_id = ? AND status = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND deadline_at > ?
      AND ai_tokens_used >= ?
  `).bind(
    reservedTokens, actualTokens, now,
    input.taskId, input.leaseToken, now, now, reservedTokens,
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

  const payload = parseJson(row.payload_json, {});
  const isImprovementRequest = payload?.improvementRequest === true;
  const decision = decideTaskRetry({
    nowMs,
    createdAtMs: fromSqliteDateTime(row.created_at),
    deadlineAtMs: fromSqliteDateTime(row.deadline_at),
    maxTaskAgeMs: isImprovementRequest
      ? TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs
      : TASK_BUDGET_CEILINGS.maxTaskAgeMs,
    maxRetryDelayMs: isImprovementRequest
      ? TASK_BUDGET_CEILINGS.maxImprovementRetryDelayMs
      : TASK_BUDGET_CEILINGS.maxDelayMs,
    retryDelaysMs: isImprovementRequest ? [60 * 60 * 1000, 3 * 60 * 60 * 1000, 3 * 60 * 60 * 1000] : undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorClass: input.errorClass,
    retryable: input.retryable === true,
  });

  if (decision.action === "retry") {
    const retryAt = toSqliteDateTime(decision.retryAtMs);
    const result = await db.prepare(`
      UPDATE agent_tasks
      SET status = 'waiting', next_attempt_at = ?, updated_at = ?,
          last_error_class = ?, last_error = ?, stop_reason = NULL,
          attempts = CASE WHEN ? = 'workers_ai_daily_quota_exhausted' THEN MAX(0, attempts - 1) ELSE attempts END,
          deadline_at = CASE WHEN ? = 'workers_ai_daily_quota_exhausted' THEN datetime(?, '+1 hour') ELSE deadline_at END,
          lease_token = NULL, lease_expires_at = NULL
      WHERE task_id = ? AND status = 'running' AND lease_token = ?
        AND lease_expires_at > ?
    `).bind(
      retryAt, now, input.errorClass ?? "unknown", safeErrorDetail(input.errorDetail),
      input.errorClass ?? "unknown", input.errorClass ?? "unknown", retryAt,
      input.taskId, input.leaseToken, now,
    ).run();
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
