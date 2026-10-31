import assert from "node:assert/strict";
import { classifyAgentTaskError, decideTaskRetry, describeAgentTaskStopReason, TASK_BUDGET_CEILINGS } from "../src/background-task-policy.mjs";

const base = {
  nowMs: 10_000,
  createdAtMs: 0,
  deadlineAtMs: 3_600_000,
  attempts: 1,
  maxAttempts: 4,
  errorClass: "network_error",
  retryable: true,
};

const first = decideTaskRetry(base);
assert.equal(first.action, "retry");
assert.equal(first.status, "waiting");
assert.equal(first.delayMs, 30_000);
assert.equal(first.retryAtMs, 40_000);

const second = decideTaskRetry({ ...base, attempts: 2 });
const dailyQuota = decideTaskRetry({ ...base, nowMs: Date.parse("2026-10-30T12:00:00.000Z"), deadlineAtMs: Date.parse("2026-10-30T13:00:00.000Z"), errorClass: "workers_ai_daily_quota_exhausted", retryable: true });
assert.equal(dailyQuota.action, "retry");
assert.equal(dailyQuota.retryAtMs, Date.parse("2026-10-31T00:01:00.000Z"));
const quotaAttemptsExhausted = decideTaskRetry({ ...base, attempts: 4, maxAttempts: 4, errorClass: "workers_ai_daily_quota_exhausted", retryable: true });
assert.equal(quotaAttemptsExhausted.action, "stop", "Daily quota waits must still obey the cumulative task attempt budget");
assert.equal(quotaAttemptsExhausted.stopReason, "attempt_budget_exhausted");
const quotaRetryAfterReset = decideTaskRetry({
  ...base,
  nowMs: Date.parse("2026-10-31T00:01:00.000Z"),
  deadlineAtMs: Date.parse("2026-10-31T01:01:00.000Z"),
  errorClass: "workers_ai_daily_quota_exhausted",
  previousErrorClass: "workers_ai_daily_quota_exhausted",
  retryable: true,
});
assert.equal(quotaRetryAfterReset.retryAtMs, Date.parse("2026-10-31T01:01:00.000Z"));
assert.equal(second.delayMs, 60_000);
const capped = decideTaskRetry({ ...base, attempts: 6, maxAttempts: 99 });
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
  "unknown_tool",
  "tool_loop_detected",
  "tool_budget_exhausted",
  "tool_output_too_large",
  "web_research_not_enabled",
  "web_research_budget_exhausted",
  "web_research_unverified",
  "web_research_sources_missing",
  "web_research_invalid_response",
  "web_research_provider_error",
  "workers_ai_permanent_failure",
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
  decideTaskRetry({ ...base, deadlineAtMs: 20_000 }).stopReason,
  "retry_would_exceed_task_deadline",
);

// AI call/token counters are telemetry only and cannot stop a task.
assert.equal(decideTaskRetry({ ...base, aiCallsUsed: 1_000_000, aiTokensUsed: 9_000_000_000 }).action, "retry");
// Persisted row values cannot raise the retry-attempt ceiling.
assert.equal(
  decideTaskRetry({ ...base, attempts: 6, maxAttempts: 1_000 }).stopReason,
  "attempt_budget_exhausted",
);
const deadlineClamped = decideTaskRetry({
  ...base,
  deadlineAtMs: 9_999_999_999,
  nowMs: 3_590_000,
});
assert.equal(deadlineClamped.action, "stop");
assert.equal(deadlineClamped.stopReason, "retry_would_exceed_task_deadline");
const reassessedDeadline = decideTaskRetry({ ...base, nowMs: 3_590_000, deadlineAtMs: 9_999_999, allowDeadlineExtension: true });
assert.equal(reassessedDeadline.action, "retry", "An explicit, bounded improvement-task reassessment may extend its persisted deadline.");

assert.equal(TASK_BUDGET_CEILINGS.maxAttempts, 6);
assert.equal(TASK_BUDGET_CEILINGS.maxTaskAgeMs, 3_600_000);
assert.equal(TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs, 8 * 60 * 60 * 1000);
assert.equal(TASK_BUDGET_CEILINGS.maxImprovementRetryDelayMs, 3 * 60 * 60 * 1000);

const improvementRetry = {
  ...base,
  deadlineAtMs: 8 * 60 * 60 * 1000,
  maxTaskAgeMs: 8 * 60 * 60 * 1000,
  maxRetryDelayMs: 3 * 60 * 60 * 1000,
  retryDelaysMs: [60 * 60 * 1000, 3 * 60 * 60 * 1000, 3 * 60 * 60 * 1000],
};
assert.equal(decideTaskRetry(improvementRetry).delayMs, 60 * 60 * 1000);
assert.equal(decideTaskRetry({ ...improvementRetry, attempts: 2 }).delayMs, 3 * 60 * 60 * 1000);
assert.equal(decideTaskRetry({ ...improvementRetry, attempts: 3 }).delayMs, 3 * 60 * 60 * 1000);
assert.equal(decideTaskRetry({ ...improvementRetry, attempts: 4 }).stopReason, "attempt_budget_exhausted");

// --- classifyAgentTaskError (moved from src/index.js in #86) ---
// Every fixed class is matched from the message, in list order.
for (const fixed of [
  "credentials_detected",
  "pii_masking_failed",
  "invalid_input",
  "policy_violation",
  "unauthorized",
  "forbidden",
  "unknown_tool",
  "tool_loop_detected",
  "tool_budget_exhausted",
  "web_research_not_enabled",
  "web_research_budget_exhausted",
  "web_research_unverified",
  "web_research_sources_missing",
  "web_research_invalid_response",
  "web_research_provider_error",
  "tool_output_too_large",
  "workers_ai_daily_quota_exhausted",
]) {
  assert.equal(classifyAgentTaskError(new Error("failed: " + fixed)), fixed, fixed);
}
// Fixed classes win over the regex classes, and the fixed list order (not the
// position inside the message) decides between multiple fixed classes.
assert.equal(classifyAgentTaskError(new Error("credentials_detected (HTTP 429)")), "credentials_detected");
assert.equal(
  classifyAgentTaskError(new Error("rate_limited then credentials_detected")),
  "credentials_detected",
);
// Regex classes, in evaluation order.
assert.equal(classifyAgentTaskError(new Error("workers_ai_request_failed: daily Neurons quota exhausted")), "workers_ai_daily_quota_exhausted");
assert.equal(classifyAgentTaskError(new Error("workers_ai_request_failed: WorkersAiError: account limited (code=3036)")), "workers_ai_daily_quota_exhausted");
assert.equal(classifyAgentTaskError(new Error("HTTP 429 Too Many Requests")), "rate_limited");
assert.equal(classifyAgentTaskError(new Error("Rate limit exceeded")), "rate_limited");
assert.equal(classifyAgentTaskError(new Error("quota exhausted for this project")), "rate_limited");
assert.equal(classifyAgentTaskError(new TypeError("429 from upstream")), "rate_limited");
assert.equal(classifyAgentTaskError(new Error("Gemini API returned 500")), "upstream_5xx");
assert.equal(classifyAgentTaskError(new Error("Gemini API returned 503 Service Unavailable")), "upstream_5xx");
assert.equal(classifyAgentTaskError(new Error("workers_ai_request_failed: WorkersAiError: upstream unavailable (code=503)")), "upstream_5xx");
assert.equal(classifyAgentTaskError(new Error("Error: workers_ai_request_failed")), "workers_ai_transient_failure");
assert.equal(classifyAgentTaskError(new Error("workers_ai_request_failed: HTTP 400 invalid request")), "workers_ai_permanent_failure");
const nestedProviderFailure = new Error("workers_ai_failure_settlement_failed");
nestedProviderFailure.workersAiError = { name: "WorkersAiError", message: "upstream unavailable", code: "model_error", status: 503 };
assert.equal(classifyAgentTaskError(nestedProviderFailure), "upstream_5xx");
const nestedQuotaFailure = new Error("workers_ai_failure_settlement_failed");
nestedQuotaFailure.workersAiError = { name: "WorkersAiError", message: "daily Neurons allocation exhausted", status: 429 };
assert.equal(classifyAgentTaskError(nestedQuotaFailure), "workers_ai_daily_quota_exhausted");
const timeoutByName = new Error("boom");
timeoutByName.name = "TimeoutError";
assert.equal(classifyAgentTaskError(timeoutByName), "timeout");
const abortByName = new Error("boom");
abortByName.name = "AbortError";
assert.equal(classifyAgentTaskError(abortByName), "timeout");
assert.equal(classifyAgentTaskError(new Error("request timeout after 30s")), "timeout");
assert.equal(classifyAgentTaskError(new TypeError("timeout while fetching")), "timeout");
assert.equal(classifyAgentTaskError(new TypeError("fetch failed")), "network_error");
assert.equal(classifyAgentTaskError(new TypeError("some type problem")), "network_error");
assert.equal(classifyAgentTaskError(new Error("network unreachable")), "network_error");
assert.equal(classifyAgentTaskError(new Error("connection reset by peer")), "network_error");
// Anything else, including a missing message, fails closed to "unknown".
assert.equal(classifyAgentTaskError(new Error("something completely different")), "unknown");
assert.equal(classifyAgentTaskError(new Error()), "unknown");
assert.equal(classifyAgentTaskError({}), "unknown");
assert.equal(classifyAgentTaskError(null), "unknown");
assert.equal(classifyAgentTaskError(undefined), "unknown");

// --- describeAgentTaskStopReason (moved from src/index.js in #86) ---
const GUIDANCE = {
  task_deadline_exceeded: ["処理時間の上限に到達", "依頼を小さく分け、新しい /task として依頼してください。"],
  retry_would_exceed_task_deadline: ["処理時間の上限に到達するため再試行できない", "依頼を小さく分け、新しい /task として依頼してください。"],
  attempt_budget_exhausted: ["再試行回数の上限に到達", "依頼内容を絞り、新しい /task として依頼してください。"],
  workers_ai_daily_quota_exhausted: ["Workers AI の日次無料枠に到達", "Cloudflare の日次リセット（UTC 00:00）後に自動再開します。"],
  daily_workflow_budget_exhausted: ["本日の背景タスク上限に到達", "翌日以降に、必要な内容を絞って再依頼してください。"],
  credentials_detected: ["認証情報を検出", "認証情報を依頼文から削除してから再依頼してください。"],
  pii_masking_failed: ["個人情報を安全にマスキングできない", "個人を特定できる情報を除いてから再依頼してください。"],
  web_research_not_enabled: ["Web 調査は現在無効", "Web 調査の有効化を待つ間は、ナレッジ検索を /task で依頼してください。"],
  web_research_sources_missing: ["調査結果の出典を確認できない", "出典を確認できる依頼内容に絞って、新しい /research として依頼してください。"],
  web_research_unverified: ["調査結果を検証できない", "検証対象を絞って、新しい /research として依頼してください。"],
  non_retryable_or_unknown_error: ["安全に再試行できると確認できないエラー", "依頼内容を確認し、対象を絞って新しい /task として依頼してください。"],
};
for (const [reason, [label, nextAction]] of Object.entries(GUIDANCE)) {
  assert.deepEqual(describeAgentTaskStopReason(reason), { label, nextAction }, reason);
}
// The non_retryable_ prefix is normalized before the table lookup.
assert.deepEqual(
  describeAgentTaskStopReason("non_retryable_credentials_detected"),
  { label: "認証情報を検出", nextAction: "認証情報を依頼文から削除してから再依頼してください。" },
);
assert.deepEqual(
  describeAgentTaskStopReason("non_retryable_task_deadline_exceeded"),
  { label: "処理時間の上限に到達", nextAction: "依頼を小さく分け、新しい /task として依頼してください。" },
);
// Unknown reasons fall back to the raw reason plus the default next action;
// empty or non-string reasons report that no stop reason was recorded.
const DEFAULT_NEXT_ACTION = "依頼内容を確認し、対象を絞って新しい /task として依頼してください。";
assert.deepEqual(
  describeAgentTaskStopReason("some_unlisted_reason"),
  { label: "some_unlisted_reason", nextAction: DEFAULT_NEXT_ACTION },
);
assert.deepEqual(
  describeAgentTaskStopReason("non_retryable_mystery"),
  { label: "non_retryable_mystery", nextAction: DEFAULT_NEXT_ACTION },
);
for (const empty of ["", null, undefined, 0]) {
  assert.deepEqual(
    describeAgentTaskStopReason(empty),
    { label: "停止理由は未記録", nextAction: DEFAULT_NEXT_ACTION },
    String(empty),
  );
}

console.log("Background task retry policy tests passed.");
