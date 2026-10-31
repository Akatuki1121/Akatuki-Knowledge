// Global Workers AI context ceiling. Improvement tasks use a smaller per-response cap.
export const WORKERS_AI_MAX_OUTPUT_TOKENS = 131_072;
export const IMPROVEMENT_TASK_MAX_OUTPUT_TOKENS = 8_192;
export const IMPROVEMENT_TASK_REASONING_EFFORT = "high";
export const IMPROVEMENT_TASK_RUNTIME_DEFAULTS = Object.freeze({
  maxOutputTokens: IMPROVEMENT_TASK_MAX_OUTPUT_TOKENS,
  reasoningEffort: IMPROVEMENT_TASK_REASONING_EFFORT,
  allowWebResearch: false,
});
export function normalizeImprovementTaskRuntimePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("improvement task payload must be an object");
  return { ...payload, ...IMPROVEMENT_TASK_RUNTIME_DEFAULTS };
}
