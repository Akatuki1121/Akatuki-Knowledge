import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
]) {
  assert.ok(source.includes(required), "Missing background task store contract: " + required);
}
assert.ok(!source.includes("input.error.message"), "Raw exception messages must not be persisted");
console.log("Background task store contract checks passed.");
