import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toSqliteDateTime } from "../src/background-task-store.mjs";

const source = await readFile(new URL("../src/background-task-store.mjs", import.meta.url), "utf8");
for (const required of [
  "ON CONFLICT(idempotency_key) DO NOTHING",
  "export async function listAgentTasks",
  "export async function cancelAgentTask",
  "SET status = 'cancelled', stop_reason = 'user_cancelled'",
  "WHERE task_id = ? AND notify_chat_id = ?",
  "Unsupported task status filter",
  "ORDER BY updated_at DESC",
  "budget_reserved = 1",
  "SET budget_reserved = 1",
  "notify_chat_id, notification_status, notification_next_attempt_at",
  "UPDATE agent_tasks",
  "lease_expires_at <= ?",
  "attempts = attempts + 1",
  "RETURNING *",
  "status = 'running' AND lease_token = ?",
  "checkpoint_json = ?",
  "status = 'succeeded'",
  "decideTaskRetry(",
  "safeErrorDetail(input.errorDetail)",
  "last_error_class = COALESCE(NULLIF(last_error_class, ''), CASE",
  "lease_expires_at = datetime(?, '+120 seconds')",
  "task_deadline_exceeded",
  "attempt_budget_exhausted",
  "export async function reserveAgentAiBudget",
  "export async function settleAgentAiBudget",
  "export async function reserveQueuedAgentTaskBudget",
  "export async function requeueAgentTaskAfterBudgetWait",
  "queuedForBudget: true",
  "ai_calls_used = ai_calls_used + 1",
  "ai_tokens_used = ai_tokens_used + ?",
  "ai_tokens_used = MAX(0, ai_tokens_used - ?) + ?",
  "export async function renewAgentTaskLease",
  "AND lease_expires_at > ?",
  "AND deadline_at > ?",
  "agent_task_daily_budget",
  "agent_task_budget_reservations",
  "counted = 0",
  "counted = 1",
  "counted = 2",
  "SET counted = 2",
  "const results = await db.batch(statements)",
  "workflow_steps_reserved + 32 <= 2700",
  "daily_workflow_budget_exhausted",
]) {
  assert.ok(source.includes(required), "Missing background task store contract: " + required);
}
assert.ok(source.includes("export async function reserveQueuedAgentTaskBudget"), "Workflow capacity must be reserved for queued tasks after the UTC reset");
assert.ok(!source.includes("ai_calls_used < max_ai_calls"), "AI call counters must not be an admission gate");
assert.ok(!source.includes("ai_tokens_used + ? <= max_ai_tokens"), "AI token counters must not be an admission gate");
assert.ok(!source.includes("tasks_reserved < 60"), "Task admission must not use an arbitrary daily task-count cap");
assert.ok(!source.includes("workflow_steps_reserved + 32 <= 2000"), "Workflow admission must use the Cloudflare Free step budget");
assert.ok(!source.includes("input.error.message"), "Raw exception messages must not be persisted");
const failureRecorder = source.slice(source.indexOf("export async function recordAgentTaskFailure"));
assert.ok(failureRecorder.includes("WHERE task_id = ? AND status = 'running' AND lease_token = ?"), "Failure recording must be fenced by task status and lease token");
assert.ok(!failureRecorder.includes("lease_expires_at > ?"), "An expired but unreclaimed lease must still be able to persist its failure");
assert.equal(toSqliteDateTime(Date.UTC(2026, 9, 20, 12, 34, 56)), "2026-10-20 12:34:56");
console.log("Background task store contract checks passed.");

const insertIndex = source.indexOf("INSERT INTO agent_tasks (");
const reservationIndex = source.indexOf("INSERT INTO agent_task_daily_budget (");
assert.ok(insertIndex >= 0 && reservationIndex > insertIndex, "Task insertion must precede daily budget reservation");
assert.ok(source.includes("const results = await db.batch(statements)"), "Task creation and budget reservation must run in one D1 batch");
assert.ok(source.includes("WHERE task_id = ? AND budget_day = ? AND counted = 0"), "A task's daily reservation must be counted at most once");
assert.ok(source.includes("WHERE task_id = ? AND counted = 2"), "A task must be admitted only after its budget counter increment completes");
assert.ok(source.indexOf("SET counted = 1") < source.indexOf("SET tasks_reserved = tasks_reserved + 1"), "Reservation must be claimed before the daily counter increment");
assert.ok(source.indexOf("SET tasks_reserved = tasks_reserved + 1") < source.indexOf("SET counted = 2"), "Reservation must be finalized after the daily counter increment");
assert.ok(source.includes("ON CONFLICT(task_id) DO NOTHING"), "Duplicate admission must not create a second reservation");
assert.equal(toSqliteDateTime(Date.UTC(2026, 9, 20, 12, 34, 56)), "2026-10-20 12:34:56");
console.log("Background task store contract checks passed.");
