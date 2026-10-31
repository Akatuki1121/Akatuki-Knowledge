// Canonical runtime settings shared by task admission, reassessment, and execution.
export const WORKERS_AI_MAX_OUTPUT_TOKENS = 131_072;

// These are execution parameters, not task identity or authorization.
// GitHub read/write permissions and the original prompt are intentionally preserved.
export const IMPROVEMENT_TASK_RUNTIME_DEFAULTS = Object.freeze({
  maxOutputTokens: WORKERS_AI_MAX_OUTPUT_TOKENS,
  allowWebResearch: false,
});

export function normalizeImprovementTaskRuntimePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("improvement task payload must be an object");
  }
  return { ...payload, ...IMPROVEMENT_TASK_RUNTIME_DEFAULTS };
}
