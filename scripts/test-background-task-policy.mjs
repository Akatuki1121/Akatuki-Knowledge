import assert from "node:assert/strict";
import { decideTaskRetry, TASK_BUDGET_CEILINGS } from "../src/background-task-policy.mjs";

const base = {
  nowMs: 10_000,
  createdAtMs: 0,
  deadlineAtMs: 3_600_000,
  attempts: 1,
  maxAttempts: 4,
  aiCallsUsed: 1,
  maxAiCalls: 20,
  aiTokensUsed: 100,
  maxAiTokens: 40_000,
  errorClass: "network_error",
  retryable: true,
};

const first = decideTaskRetry(base);
assert.equal(first.action, "retry");
assert.equal(first.status, "waiting");
assert.equal(first.delayMs, 30_000);
assert.equal(first.retryAtMs, 40_000);

const second = decideTaskRetry({ ...base, attempts: 2 });
assert.equal(second.delayMs, 60_000);
const capped = decideTaskRetry({ ...base, attempts: 4, maxAttempts: 99 });
assert.equal(capped.action, "stop");
assert.equal(capped.stopReason, "attempt_budget_exhausted");

for (const errorClass of [
  "credentials_detected",
  "pii_masking_failed",
  "unauthorized",
  "forbidden",
  "invalid_input",
  "policy_violation",
  "validation_error",
]) {
  const decision = decideTaskRetry({ ...base, errorClass });
  assert.equal(decision.action, "stop", errorClass);
  assert.equal(decision.stopReason, "non_retryable_" + errorClass);
}

assert.equal(
  decideTaskRetry({ ...base, errorClass: "mystery_error" }).stopReason,
  "non_retryable_or_unknown_error",
);
assert.equal(
  decideTaskRetry({ ...base, retryable: false }).stopReason,
  "non_retryable_or_unknown_error",
);
assert.equal(
  decideTaskRetry({ ...base, nowMs: 3_600_000 }).stopReason,
  "task_deadline_exceeded",
);
assert.equal(
  decideTaskRetry({ ...base, aiCallsUsed: 20 }).stopReason,
  "ai_call_budget_exhausted",
);
assert.equal(
  decideTaskRetry({ ...base, aiTokensUsed: 40_000 }).stopReason,
  "ai_token_budget_exhausted",
);
assert.equal(
  decideTaskRetry({ ...base, deadlineAtMs: 20_000 }).stopReason,
  "retry_would_exceed_task_deadline",
);

// Persisted row values cannot raise the hard ceilings.
assert.equal(
  decideTaskRetry({ ...base, attempts: 4, maxAttempts: 1_000 }).stopReason,
  "attempt_budget_exhausted",
);
assert.equal(
  decideTaskRetry({ ...base, aiCallsUsed: 20, maxAiCalls: 1_000 }).stopReason,
  "ai_call_budget_exhausted",
);
assert.equal(
  decideTaskRetry({ ...base, aiTokensUsed: 40_000, maxAiTokens: 1_000_000 }).stopReason,
  "ai_token_budget_exhausted",
);
const deadlineClamped = decideTaskRetry({
  ...base,
  deadlineAtMs: 9_999_999_999,
  nowMs: 3_590_000,
});
assert.equal(deadlineClamped.action, "stop");
assert.equal(deadlineClamped.stopReason, "retry_would_exceed_task_deadline");

assert.equal(TASK_BUDGET_CEILINGS.maxAttempts, 4);
assert.equal(TASK_BUDGET_CEILINGS.maxTaskAgeMs, 3_600_000);
console.log("Background task retry policy tests passed.");
