const TARGET_REPOSITORY = "Akatuki1121/Akatuki-Knowledge";
const ALLOWED_FILE_ROOTS = Object.freeze([
  "src/",
  "scripts/",
  "tests/",
  "docs/",
  "schema-snapshots/",
  "migrations/pending/",
]);
const ALLOWED_ROOT_FILES = new Set(["wrangler.toml", "package.json", "package-lock.json", "README.md"]);
const PROTECTED_WORKFLOWS = new Set([
  ".github/workflows/auto-merge.yml",
  ".github/workflows/check.yml",
  ".github/workflows/deploy.yml",
]);
// Guardrail files that define the improvement agent's own constraints
// (retry classification and limits, writable scope, execution and
// auto-merge, audit shape, model and output limits). The agent must never
// rewrite its own guardrails, so these paths are rejected outright with
// the dedicated reason code, whether the change would tighten or loosen.
const PROTECTED_PATHS = new Set([
  "src/background-task-policy.mjs",
  "src/background-task-store.mjs",
  "src/agent-improvement-policy.mjs",
  "src/agent-improvement-executor.mjs",
  "src/budget-self-audit.mjs",
  "src/task-runtime-config.mjs",
]);
const ALLOWED_OPERATION_TYPES = new Set(["create_branch", "create_file", "update_file", "apply_patch", "create_pull_request"]);
// Size caps for plans the improvement agent may execute on its own. Plans
// beyond these bounds stop with plan_too_large_for_agent and are handed to
// Muse through the escalation writeback instead of being executed.
// The file-operation cap follows the observed record of successful pull
// requests (median 4 changed files; the only agent-branch precedent changed
// 5), and the total payload cap sits at roughly twice the 90th percentile of
// observed diff volume while excluding feature-scale changes.
export const MAX_PLAN_FILE_OPERATIONS = 5;
export const MAX_PLAN_TOTAL_PAYLOAD_CHARS = 60_000;
const MAX_FILE_CONTENT_CHARS = 200_000;
const MAX_PATCH_CHARS = 100_000;

function hasExplicitReadOnlyWorkflowPermissions(content) {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^permissions:\s*(?:read-all|\{\})?\s*(?:#.*)?$/u.test(line));
  if (index < 0) return false;
  const declaration = lines[index].replace(/^permissions:\s*/u, "").trim();
  if (declaration === "read-all" || declaration === "{}") return true;
  let entries = 0;
  for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    if (!/^\s{2,}/u.test(line)) break;
    if (!/^\s{2,}[A-Za-z0-9_-]+:\s*read\s*(?:#.*)?$/u.test(line)) return false;
    entries++;
  }
  return entries > 0;
}

// Returns null when the path is writable for the operation, otherwise the
// rejection reason code. Protected guardrail paths get their own code so a
// stopped plan can be routed to Muse with the reason attached.
function validRepositoryPath(path, operationType, content) {
  if (typeof path !== "string" || !path || path.length > 240
    || path.startsWith("/") || path.includes("\\")
    || path.split("/").some((part) => part === ".." || part === "." || part === "")) return "changed_path_out_of_scope";
  if (PROTECTED_PATHS.has(path)) return "changed_path_protected";
  if (ALLOWED_FILE_ROOTS.some((root) => path.startsWith(root))) return null;
  if (ALLOWED_ROOT_FILES.has(path)) {
    return operationType === "update_file" || operationType === "apply_patch" ? null : "changed_path_out_of_scope";
  }
  if (path.startsWith(".github/workflows/")) {
    return operationType === "create_file" && !PROTECTED_WORKFLOWS.has(path)
      && /^[a-z0-9][a-z0-9._-]*\.ya?ml$/iu.test(path.slice(".github/workflows/".length))
      && typeof content === "string"
      && hasExplicitReadOnlyWorkflowPermissions(content)
      && !/(?:pull_request_target|workflow_run|secrets\.|write-all|[A-Za-z0-9_-]+:\s*write)/iu.test(content)
      ? null : "changed_path_out_of_scope";
  }
  return "changed_path_out_of_scope";
}

export function validateImprovementPlan(plan) {
  if (!plan || plan.repository !== TARGET_REPOSITORY
    || !Array.isArray(plan.operations) || plan.operations.length < 3) {
    return { ok: false, reason: "plan_shape_not_allowed" };
  }
  if (plan.operations.some((operation) => !ALLOWED_OPERATION_TYPES.has(operation?.type))) {
    return { ok: false, reason: "operation_type_not_allowed" };
  }

  const fileOperations = plan.operations.filter((operation) =>
    operation.type === "create_file" || operation.type === "update_file" || operation.type === "apply_patch");
  if (fileOperations.length === 0) return { ok: false, reason: "no_file_changes" };
  if (fileOperations.length > MAX_PLAN_FILE_OPERATIONS) {
    return { ok: false, reason: "plan_too_large_for_agent" };
  }
  let totalPayloadChars = 0;
  for (const operation of fileOperations) {
    const pathRejection = validRepositoryPath(operation.path, operation.type, operation.type === "apply_patch" ? operation.patch : operation.content);
    if (pathRejection) {
      return { ok: false, reason: pathRejection };
    }
    if ((operation.type === "update_file" || operation.type === "apply_patch")
      && (typeof operation.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(operation.sha))) {
      return { ok: false, reason: "existing_file_sha_required" };
    }
    const filePayload = operation.type === "apply_patch" ? operation.patch : operation.content;
    const maxFilePayload = operation.type === "apply_patch" ? MAX_PATCH_CHARS : MAX_FILE_CONTENT_CHARS;
    if (typeof filePayload !== "string" || filePayload.length > maxFilePayload) {
      return { ok: false, reason: "file_content_invalid_or_too_large" };
    }
    totalPayloadChars += filePayload.length;
  }
  if (totalPayloadChars > MAX_PLAN_TOTAL_PAYLOAD_CHARS) {
    return { ok: false, reason: "plan_too_large_for_agent" };
  }

  const branches = plan.operations.filter((operation) => operation.type === "create_branch");
  const pullRequests = plan.operations.filter((operation) => operation.type === "create_pull_request");
  if (branches.length !== 1 || pullRequests.length !== 1
    || plan.operations[0]?.type !== "create_branch"
    || plan.operations.at(-1)?.type !== "create_pull_request") {
    return { ok: false, reason: "branch_and_pull_request_required" };
  }

  const branch = branches[0].branch;
  if (typeof branch !== "string" || !/^agent\/[a-z0-9][a-z0-9._/-]{0,80}$/iu.test(branch)
    || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
    return { ok: false, reason: "branch_name_invalid" };
  }
  if (branches[0].base_ref !== "main"
    || fileOperations.some((operation) => operation.branch !== branch)
    || pullRequests[0].head !== branch || pullRequests[0].base !== "main"
    || pullRequests[0].draft !== false) {
    return { ok: false, reason: "branch_mismatch_or_draft_pr" };
  }
  return { ok: true };
}

export async function improvementIdempotencyKey(syncUuid, contentHash) {
  if (typeof syncUuid !== "string" || !syncUuid || typeof contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(contentHash)) {
    throw new TypeError("invalid_improvement_identity");
  }
  const input = new TextEncoder().encode(syncUuid + ":" + contentHash);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return "improvement:" + hash;
}

/**
 * Remove result sections generated by the improvement agent before comparing
 * or retrying the user's original request. Only trailing, explicitly marked
 * result blocks are removed; user-authored content is otherwise preserved.
 */
export function stripImprovementResults(content) {
  let cleaned = String(content ?? "");
  const resultBlock = /(?:\r?\n){2}<!-- akatuki-improvement-result:[^>]+ -->\r?\n### 改善エージェント実行結果\r?\n\r?\n\x60\x60\x60json\r?\n[\s\S]*?\r?\n\x60\x60\x60\s*$/u;
  while (resultBlock.test(cleaned)) cleaned = cleaned.replace(resultBlock, "");
  return cleaned.trimEnd();
}
