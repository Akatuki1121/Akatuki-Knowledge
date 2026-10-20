import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toSqliteDateTime } from "../src/background-task-store.mjs";

const source = await readFile(new URL("../src/background-task-store.mjs", import.meta.url), "utf8");
for (const required of [
  "ON CONFLICT(idempotency_key) DO NOTHING",
  "budget_reserved = 1",
  "SET budget_reserved = 1",
  "agent_task_insert_conflict",
  "notify_chat_id, notification_status, notification_next_attempt_at",
  "UPDATE agent_tasks",
  "lease_expires_at <= ?",
  "attempts = attempts + 1",
  "RETURNING *",
  "status = 'running' AND lease_token = ?",
  "checkpoint_json = ?",
  "status = 'succeeded'",
  "decideTaskRetry(",
  "last_error = NULL",
  "task_deadline_exceeded",
  "attempt_budget_exhausted",
  "ai_call_budget_exhausted",
  "ai_token_budget_exhausted",
  "export async function reserveAgentAiBudget",
  "ai_calls_used = ai_calls_used + 1",
  "ai_tokens_used = ai_tokens_used + ?",
  "ai_tokens_used + ? <= max_ai_tokens",
  "ai_tokens_used + ? > max_ai_tokens",
  "export async function renewAgentTaskLease",
  "AND lease_expires_at > ?",
  "AND deadline_at > ?",
  "agent_task_daily_budget",
  "agent_task_budget_reservations",
  "counted = 0",
  "counted = 1",
  "const results = await db.batch(statements)",
  "tasks_reserved < 60",
  "workflow_steps_reserved + 32 <= 2000",
  "daily_workflow_budget_exhausted",
]) {
  assert.ok(source.includes(required), "Missing background task store contract: " + required);
}
assert.ok(!source.includes("input.error.message"), "Raw exception messages must not be persisted");
const insertIndex = source.indexOf("INSERT INTO agent_tasks (");
const reservationIndex = source.indexOf("INSERT INTO agent_task_daily_budget (");
assert.ok(insertIndex >= 0 && reservationIndex > insertIndex, "Task insertion must precede daily budget reservation");
assert.ok(source.includes("const results = await db.batch(statements)"), "Task creation and budget reservation must run in one D1 batch");
assert.ok(source.includes("WHERE task_id = ? AND budget_day = ? AND counted = 0"), "A task's daily reservation must be counted at most once");
assert.ok(source.includes("ON CONFLICT(task_id) DO NOTHING"), "Duplicate admission must not create a second reservation");
assert.equal(toSqliteDateTime(Date.UTC(2026, 9, 20, 12, 34, 56)), "2026-10-20 12:34:56");
console.log("Background task store contract checks passed.");
