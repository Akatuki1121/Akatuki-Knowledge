export const TASK_BUDGET_CEILINGS = Object.freeze({
  maxAttempts: 4,
  maxTaskAgeMs: 60 * 60 * 1000,
  maxDelayMs: 30 * 60 * 1000,
  maxAiCalls: 20,
  maxAiTokens: 40_000,
  baseDelayMs: 30_000,
});

const NON_RETRYABLE = new Set([
  "credentials_detected",
  "pii_masking_failed",
  "unauthorized",
  "forbidden",
  "invalid_input",
  "policy_violation",
  "validation_error",
]);

const TRANSIENT = new Set([
  "network_error",
  "timeout",
  "rate_limited",
  "upstream_5xx",
  "executor_interrupted",
]);

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Decide whether a failed attempt may be retried.
 * attempts counts attempts already started, including the failed attempt.
 * Unknown error classes fail closed. Callers must persist the returned decision.
 */
export function decideTaskRetry(input) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const createdAtMs = finiteNumber(input.createdAtMs, nowMs);
  const hardDeadlineMs = createdAtMs + TASK_BUDGET_CEILINGS.maxTaskAgeMs;
  const suppliedDeadlineMs = finiteNumber(input.deadlineAtMs, hardDeadlineMs);
  const deadlineMs = Math.min(suppliedDeadlineMs, hardDeadlineMs);

  const attempts = Math.max(0, Math.floor(finiteNumber(input.attempts, 0)));
  const maxAttempts = Math.min(
    TASK_BUDGET_CEILINGS.maxAttempts,
    Math.max(1, Math.floor(finiteNumber(input.maxAttempts, TASK_BUDGET_CEILINGS.maxAttempts))),
  );
  const aiCallsUsed = Math.max(0, Math.floor(finiteNumber(input.aiCallsUsed, 0)));
  const maxAiCalls = Math.min(
    TASK_BUDGET_CEILINGS.maxAiCalls,
    Math.max(1, Math.floor(finiteNumber(input.maxAiCalls, TASK_BUDGET_CEILINGS.maxAiCalls))),
  );
  const aiTokensUsed = Math.max(0, Math.floor(finiteNumber(input.aiTokensUsed, 0)));
  const maxAiTokens = Math.min(
    TASK_BUDGET_CEILINGS.maxAiTokens,
    Math.max(1, Math.floor(finiteNumber(input.maxAiTokens, TASK_BUDGET_CEILINGS.maxAiTokens))),
  );
  const errorClass = typeof input.errorClass === "string" ? input.errorClass : "unknown";

  const stop = (reason) => ({ action: "stop", status: "failed", stopReason: reason });

  if (nowMs >= deadlineMs) return stop("task_deadline_exceeded");
  if (aiCallsUsed >= maxAiCalls) return stop("ai_call_budget_exhausted");
  if (aiTokensUsed >= maxAiTokens) return stop("ai_token_budget_exhausted");
  if (attempts >= maxAttempts) return stop("attempt_budget_exhausted");
  if (NON_RETRYABLE.has(errorClass)) return stop("non_retryable_" + errorClass);
  if (!TRANSIENT.has(errorClass) || input.retryable !== true) {
    return stop("non_retryable_or_unknown_error");
  }

  const requestedBaseDelay = Math.max(
    1,
    finiteNumber(input.baseDelayMs, TASK_BUDGET_CEILINGS.baseDelayMs),
  );
  const baseDelayMs = Math.min(requestedBaseDelay, TASK_BUDGET_CEILINGS.maxDelayMs);
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  const delayMs = Math.min(
    baseDelayMs * (2 ** exponent),
    TASK_BUDGET_CEILINGS.maxDelayMs,
  );
  const retryAtMs = nowMs + delayMs;

  if (retryAtMs >= deadlineMs) return stop("retry_would_exceed_task_deadline");

  return {
    action: "retry",
    status: "waiting",
    retryAtMs,
    delayMs,
    stopReason: null,
  };
}
