export const TASK_BUDGET_CEILINGS = Object.freeze({
  maxAttempts: 4,
  maxTaskAgeMs: 60 * 60 * 1000,
  maxImprovementTaskAgeMs: 8 * 60 * 60 * 1000,
  maxDelayMs: 30 * 60 * 1000,
  maxImprovementRetryDelayMs: 3 * 60 * 60 * 1000,
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
  const maxTaskAgeMs = Math.min(
    TASK_BUDGET_CEILINGS.maxImprovementTaskAgeMs,
    Math.max(1, Math.floor(finiteNumber(input.maxTaskAgeMs, TASK_BUDGET_CEILINGS.maxTaskAgeMs))),
  );
  const hardDeadlineMs = createdAtMs + maxTaskAgeMs;
  const suppliedDeadlineMs = finiteNumber(input.deadlineAtMs, hardDeadlineMs);
  const deadlineMs = Math.min(suppliedDeadlineMs, hardDeadlineMs);

  const attempts = Math.max(0, Math.floor(finiteNumber(input.attempts, 0)));
  const maxAttempts = Math.min(
    TASK_BUDGET_CEILINGS.maxAttempts,
    Math.max(1, Math.floor(finiteNumber(input.maxAttempts, TASK_BUDGET_CEILINGS.maxAttempts))),
  );
  const errorClass = typeof input.errorClass === "string" ? input.errorClass : "unknown";

  const stop = (reason) => ({ action: "stop", status: "failed", stopReason: reason });

  // Cloudflare rejects Workers AI requests after the account-wide daily
  // Neurons allocation is exhausted. Keep the task queued until the next UTC
  // reset instead of applying an application-specific call/token ceiling.
  if (errorClass === "workers_ai_daily_quota_exhausted" && input.retryable === true) {
    const current = new Date(nowMs);
    const nextUtcResetCheck = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 1, 0);
    // Cloudflare documents a UTC daily reset. If the first post-reset probe is
    // still rejected, recheck hourly rather than parking the task for another
    // full day; provider-side quota propagation can lag the documented reset.
    const retryAtMs = input.previousErrorClass === "workers_ai_daily_quota_exhausted"
      ? nowMs + 60 * 60 * 1000
      : nextUtcResetCheck;
    return {
      action: "retry",
      status: "waiting",
      retryAtMs,
      delayMs: retryAtMs - nowMs,
      stopReason: null,
    };
  }
  if (nowMs >= deadlineMs) return stop("task_deadline_exceeded");
  if (attempts >= maxAttempts) return stop("attempt_budget_exhausted");
  if (NON_RETRYABLE.has(errorClass)) return stop("non_retryable_" + errorClass);
  if (!TRANSIENT.has(errorClass) || input.retryable !== true) {
    return stop("non_retryable_or_unknown_error");
  }

  const requestedBaseDelay = Math.max(
    1,
    finiteNumber(input.baseDelayMs, TASK_BUDGET_CEILINGS.baseDelayMs),
  );
  const maxRetryDelayMs = Math.min(
    TASK_BUDGET_CEILINGS.maxImprovementRetryDelayMs,
    Math.max(1, Math.floor(finiteNumber(input.maxRetryDelayMs, TASK_BUDGET_CEILINGS.maxDelayMs))),
  );
  const retryDelaysMs = Array.isArray(input.retryDelaysMs) ? input.retryDelaysMs : null;
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  const requestedDelay = retryDelaysMs?.length
    ? finiteNumber(retryDelaysMs[Math.min(attempts - 1, retryDelaysMs.length - 1)], requestedBaseDelay)
    : requestedBaseDelay * (2 ** exponent);
  const delayMs = Math.min(
    Math.max(1, Math.floor(requestedDelay)),
    maxRetryDelayMs,
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

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// エージェントタスクの停止理由の説明 (Issue #86)。src/index.js から移動した関数で、本文は移動前と同一。
export function describeAgentTaskStopReason(reason) {
  const normalized = typeof reason === "string" && reason.startsWith("non_retryable_")
    ? reason.slice("non_retryable_".length)
    : reason;
  const guidance = {
    task_deadline_exceeded: ["処理時間の上限に到達", "依頼を小さく分け、新しい /task として依頼してください。"],
    retry_would_exceed_task_deadline: ["処理時間の上限に到達するため再試行できない", "依頼を小さく分け、新しい /task として依頼してください。"],
    attempt_budget_exhausted: ["再試行回数の上限に到達", "依頼内容を絞り、新しい /task として依頼してください。"],
    daily_workflow_budget_exhausted: ["本日の背景タスク上限に到達", "翌日以降に、必要な内容を絞って再依頼してください。"],
    credentials_detected: ["認証情報を検出", "認証情報を依頼文から削除してから再依頼してください。"],
    pii_masking_failed: ["個人情報を安全にマスキングできない", "個人を特定できる情報を除いてから再依頼してください。"],
    workers_ai_daily_quota_exhausted: ["Workers AI の日次無料枠に到達", "Cloudflare の日次リセット（UTC 00:00）後に自動再開します。"],
    web_research_not_enabled: ["Web 調査は現在無効", "Web 調査の有効化を待つ間は、ナレッジ検索を /task で依頼してください。"],
    web_research_sources_missing: ["調査結果の出典を確認できない", "出典を確認できる依頼内容に絞って、新しい /research として依頼してください。"],
    web_research_unverified: ["調査結果を検証できない", "検証対象を絞って、新しい /research として依頼してください。"],
    non_retryable_or_unknown_error: ["安全に再試行できると確認できないエラー", "依頼内容を確認し、対象を絞って新しい /task として依頼してください。"]
  };
  const entry = guidance[reason] || guidance[normalized];
  if (entry) return { label: entry[0], nextAction: entry[1] };
  return {
    label: typeof reason === "string" && reason ? reason : "停止理由は未記録",
    nextAction: "依頼内容を確認し、対象を絞って新しい /task として依頼してください。"
  };
}
__name(describeAgentTaskStopReason, "describeAgentTaskStopReason");

// エージェントタスクのエラー分類 (Issue #86)。src/index.js から移動した関数で、本文は移動前と同一。
// 分類結果は decideTaskRetry への入力クラスになるため、固定クラスの先行一致の順序も含め本文を変えない。
export function classifyAgentTaskError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  for (const fixed of ["credentials_detected", "pii_masking_failed", "invalid_input", "policy_violation", "unauthorized", "forbidden", "unknown_tool", "tool_loop_detected", "tool_budget_exhausted", "web_research_not_enabled", "web_research_budget_exhausted", "web_research_unverified", "web_research_sources_missing", "web_research_invalid_response", "web_research_provider_error", "tool_output_too_large", "workers_ai_daily_quota_exhausted"]) {
    if (message.includes(fixed)) return fixed;
  }
  if (/workers_ai_request_failed/i.test(message) && (/(daily|neuron|quota|allocation)/i.test(message) || /code=3036\b/iu.test(message))) return "workers_ai_daily_quota_exhausted";
  if (/429|rate.?limit|quota/i.test(message)) return "rate_limited";
  if (/Gemini API returned 5\d\d/i.test(message)
    || /workers_ai_request_failed[\s\S]{0,180}\b5\d\d\b/i.test(message)) return "upstream_5xx";
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /timeout/i.test(message)) return "timeout";
  if (error instanceof TypeError || /network|fetch failed|connection/i.test(message)) return "network_error";
  return "unknown";
}
__name(classifyAgentTaskError, "classifyAgentTaskError");
