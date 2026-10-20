import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toSqliteDateTime } from "../src/background-task-store.mjs";

const source = await readFile(new URL("../src/background-task-store.mjs", import.meta.url), "utf8");
for (const required of [
  "ON CONFLICT(idempotency_key) DO NOTHING",
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
]) {
  assert.ok(source.includes(required), "Missing background task store contract: " + required);
}
assert.ok(!source.includes("input.error.message"), "Raw exception messages must not be persisted");
assert.equal(toSqliteDateTime(Date.UTC(2026, 9, 20, 12, 34, 56)), "2026-10-20 12:34:56");
console.log("Background task store contract checks passed.");
