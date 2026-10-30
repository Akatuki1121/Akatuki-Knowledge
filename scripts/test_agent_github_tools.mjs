import assert from "node:assert/strict";
import { executeGitHubReadTool, executeGitHubWritePlan, hashGitHubWritePlan, validateGitHubWritePlan, applyUnifiedPatch, GITHUB_READ_TOOLS, GITHUB_WRITE_PROPOSAL_TOOL } from "../src/agent-github-tools.mjs";

const calls = [];
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});
const fetchImpl = async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).includes("/issues/12")) {
    return response(200, {
      number: 12, title: "Bug report", state: "open", body: "Reproduce safely",
      html_url: "https://github.com/example/project/issues/12", created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z", labels: [{ name: "bug" }],
    });
  }
  if (String(url).includes("/pulls/8")) {
    return response(200, { number: 8, title: "Fix", state: "open", draft: true, merged_at: null,
      head: { ref: "fix/bug", sha: "head-sha" }, base: { ref: "main" },
      html_url: "https://github.com/example/project/pull/8", updated_at: "2026-01-03T00:00:00Z",
      changed_files: 1, additions: 2, deletions: 1 });
  }
  if (String(url).includes("/check-runs")) {
    return response(200, { total_count: 1, check_runs: [{ name: "tests", status: "completed",
      conclusion: "success", html_url: "https://github.com/example/project/actions/runs/1" }] });
  }
  if (String(url).includes("/pulls?")) {
    return response(200, [{ number: 8, title: "Fix", state: "open", draft: true, merged_at: null,
      head: { ref: "fix/bug" }, base: { ref: "main" }, html_url: "https://github.com/example/project/pull/8",
      updated_at: "2026-01-03T00:00:00Z" }]);
  }
  if (String(url).includes("/contents/README.md")) {
    return response(200, { type: "file", encoding: "base64", size: 12, sha: "abc",
      html_url: "https://github.com/example/project/blob/main/README.md",
      content: btoa("# Hello\nWorld") });
  }
  return response(404, { message: "Not Found" });
};

assert.deepEqual(Object.keys(GITHUB_READ_TOOLS).sort(), [
  "github_get_issue", "github_get_pr_checks", "github_get_pull_request", "github_list_pull_requests", "github_read_file",
].sort());
const issue = await executeGitHubReadTool("github_get_issue", {
  repository: "example/project", number: 12,
}, { fetchImpl });
assert.equal(issue.title, "Bug report");
assert.equal(issue.url, "https://github.com/example/project/issues/12");
assert.equal(calls[0].init.method, "GET");
assert.equal(calls[0].url, "https://api.github.com/repos/example/project/issues/12");

const pulls = await executeGitHubReadTool("github_list_pull_requests", {
  repository: "example/project", state: "open",
}, { fetchImpl });
assert.equal(pulls.pullRequests[0].number, 8);
assert.equal(pulls.pullRequests[0].draft, true);
const checks = await executeGitHubReadTool("github_get_pr_checks", {
  repository: "example/project", number: 8,
}, { fetchImpl });
assert.equal(checks.checks[0].name, "tests");
assert.equal(checks.checks[0].conclusion, "success");
assert.ok(calls.some((call) => call.url.endsWith("/commits/head-sha/check-runs?per_page=20")));


const file = await executeGitHubReadTool("github_read_file", {
  repository: "example/project", path: "README.md", ref: "main",
}, { fetchImpl });
assert.equal(file.content, "# Hello\nWorld");
assert.equal(file.truncated, false);
const secondLine = await executeGitHubReadTool("github_read_file", {
  repository: "example/project", path: "README.md", ref: "main", start_line: 2, end_line: 2,
}, { fetchImpl });
assert.equal(secondLine.content, "World");
assert.equal(secondLine.startLine, 2);

await assert.rejects(executeGitHubReadTool("github_read_file", {
  repository: "example/project", path: ".env", ref: "",
}, { fetchImpl }), /github_path_blocked/);
await assert.rejects(executeGitHubReadTool("github_read_file", {
  repository: "example/project", path: "../secret.txt", ref: "",
}, { fetchImpl }), /github_path_blocked/);
await assert.rejects(executeGitHubReadTool("github_get_issue", {
  repository: "example/project", number: 0,
}, { fetchImpl }), /invalid_input/);
await assert.rejects(executeGitHubReadTool("github_get_issue", {
  repository: "example/project", number: 12,
}, { fetchImpl: async () => response(404, {}) }), /github_not_found/);
await assert.rejects(executeGitHubReadTool("github_get_issue", {
  repository: "example/project", number: 12,
}, { fetchImpl: async () => response(403, {}, { "x-ratelimit-remaining": "0" }) }), /github_rate_limited/);
await assert.rejects(executeGitHubReadTool("github_delete_issue", {
  repository: "example/project", number: 12,
}, { fetchImpl }), /unknown_tool/);
assert.ok(calls.every((call) => call.init.method === "GET"), "GitHub tools must remain read-only");


const plan = validateGitHubWritePlan({
  repository: "example/project",
  summary: "Add a small README and open a draft PR",
  operations: [
    { type: "create_branch", branch: "bot/docs-update", base_ref: "main" },
    { type: "create_file", branch: "bot/docs-update", path: "docs/agent.md", content: "# Agent\\n", message: "docs: add agent note" },
    { type: "create_pull_request", head: "bot/docs-update", base: "main", title: "docs: add agent note", body: "Automated draft", draft: true },
  ],
});
assert.equal(plan.operations.length, 3);
assert.equal(plan.operations[1].content, "# Agent\\n", "file content whitespace/newlines must be preserved");
assert.match(await hashGitHubWritePlan(plan), /^[a-f0-9]{64}$/u);
assert.throws(() => validateGitHubWritePlan({
  repository: "example/project", summary: "secret", operations: [
    { type: "create_file", branch: "main", path: ".env", content: "TOKEN=x", message: "bad" },
  ],
}), /github_path_blocked/);
assert.throws(() => validateGitHubWritePlan({
  repository: "example/project", summary: "unknown operation", operations: [
    { type: "delete_repository", repository: "example/project" },
  ],
}), /unknown_tool/);

const writeCalls = [];
const writeFetch = async (url, init) => {
  writeCalls.push({ url: String(url), init });
  if (init.method === "GET" && String(url).endsWith("/git/ref/heads/main")) {
    return response(200, { object: { sha: "a".repeat(40) } });
  }
  if (init.method === "POST" && String(url).endsWith("/git/refs")) {
    return response(201, { ref: "refs/heads/bot/docs-update", object: { sha: "b".repeat(40) } });
  }
  if (init.method === "PUT" && String(url).endsWith("/contents/docs/agent.md")) {
    return response(201, { content: { path: "docs/agent.md", html_url: "https://github.com/example/project/blob/bot/docs-update/docs/agent.md" }, commit: { sha: "c".repeat(40) } });
  }
  if (init.method === "POST" && String(url).endsWith("/pulls")) {
    return response(201, { number: 9, html_url: "https://github.com/example/project/pull/9" });
  }
  return response(404, { message: "Not Found" });
};
const writes = await executeGitHubWritePlan(plan, { token: "test-token", fetchImpl: writeFetch });
assert.equal(writes.results.length, 3);
assert.equal(writes.results[2].url, "https://github.com/example/project/pull/9");
assert.ok(writeCalls.every((call) => call.init.headers.authorization === "Bearer test-token"));
assert.deepEqual(writeCalls.map((call) => call.init.method), ["GET", "POST", "PUT", "POST"]);
const manyOperations = validateGitHubWritePlan({
  repository: "example/project", summary: "many independent changes", operations: Array.from({ length: 51 }, () => ({
    type: "create_issue", title: "x", body: "",
  })),
});
assert.equal(manyOperations.operations.length, 51, "GitHub plans must not have an arbitrary operation-count ceiling");

const newline = String.fromCharCode(10);
const original = ["alpha", "beta", "gamma", ""].join(newline);
const unifiedDiff = [
  "--- a/docs/agent.md",
  "+++ b/docs/agent.md",
  "@@ -2,1 +2,1 @@",
  "-beta",
  "+BETA",
  "",
].join(newline);
assert.equal(applyUnifiedPatch(original, unifiedDiff, "docs/agent.md"), ["alpha", "BETA", "gamma", ""].join(newline));
assert.throws(() => applyUnifiedPatch(original, unifiedDiff, "docs/other.md"), /github_patch_path_mismatch/);
assert.throws(() => applyUnifiedPatch(original, unifiedDiff.replace("-beta", "-wrong"), "docs/agent.md"), /github_patch_context_mismatch/);

const patchSha = "d".repeat(40);
let patchedContent = null;
const patchFetch = async (url, init = {}) => {
  if (init.method === "GET" && String(url).endsWith("/git/ref/heads/main")) {
    return response(200, { object: { sha: "a".repeat(40) } });
  }
  if (init.method === "POST" && String(url).endsWith("/git/refs")) {
    return response(201, { ref: "refs/heads/bot/patch" });
  }
  if (init.method === "GET" && String(url).includes("/contents/docs/agent.md?ref=bot%2Fpatch")) {
    return response(200, { type: "file", encoding: "base64", size: original.length, sha: patchSha, content: btoa(original) });
  }
  if (init.method === "PUT" && String(url).endsWith("/contents/docs/agent.md")) {
    patchedContent = atob(JSON.parse(init.body).content);
    return response(200, { content: { path: "docs/agent.md" }, commit: { sha: "e".repeat(40) } });
  }
  if (init.method === "POST" && String(url).endsWith("/pulls")) {
    return response(201, { number: 10, html_url: "https://github.com/example/project/pull/10" });
  }
  return response(404, { message: "Not Found" });
};
const patchPlan = {
  repository: "example/project",
  summary: "Patch a line in an existing source file",
  operations: [
    { type: "create_branch", branch: "bot/patch", base_ref: "main" },
    { type: "apply_patch", branch: "bot/patch", path: "docs/agent.md", patch: unifiedDiff, message: "patch: update line", sha: patchSha },
    { type: "create_pull_request", head: "bot/patch", base: "main", title: "patch: update line", body: "Patch existing file", draft: false },
  ],
};
await executeGitHubWritePlan(patchPlan, { token: "test-token", fetchImpl: patchFetch });
assert.equal(patchedContent, ["alpha", "BETA", "gamma", ""].join(newline));

// The tool definition shown to the model must disclose exactly the keys the validator
// requires (Issue #90): for every operation type, a plan built from exactly the
// disclosed keys validates, while dropping or adding any key fails validation.
assert.deepEqual(GITHUB_WRITE_PROPOSAL_TOOL.arguments, ["repository", "summary", "operations"]);
const sampleOperations = {
  create_branch: { type: "create_branch", branch: "bot/task", base_ref: "main" },
  create_file: { type: "create_file", branch: "bot/task", path: "docs/note.md", content: "# Note\n", message: "docs: add note" },
  update_file: { type: "update_file", branch: "bot/task", path: "docs/note.md", content: "# Note\n", message: "docs: update note", sha: "a".repeat(40) },
  apply_patch: { type: "apply_patch", branch: "bot/task", path: "src/index.js", patch: "--- a/src/index.js\\n+++ b/src/index.js\\n@@ -1,1 +1,1 @@\\n-old\\n+new\\n", message: "patch: update index", sha: "a".repeat(40) },
  create_issue: { type: "create_issue", title: "Issue title", body: "Issue body" },
  add_issue_comment: { type: "add_issue_comment", number: 1, body: "Comment body" },
  create_pull_request: { type: "create_pull_request", head: "bot/task", base: "main", title: "PR title", body: "PR body", draft: true },
};
assert.deepEqual(Object.keys(GITHUB_WRITE_PROPOSAL_TOOL.operationArguments).sort(), Object.keys(sampleOperations).sort(),
  "The definition must disclose every operation type the validator accepts, and no others");
for (const [type, keys] of Object.entries(GITHUB_WRITE_PROPOSAL_TOOL.operationArguments)) {
  const sample = sampleOperations[type];
  assert.deepEqual(Object.keys(sample).sort(), [...keys].sort(), `sample for ${type} must use exactly the disclosed keys`);
  const wrap = (operation) => ({ repository: "example/project", summary: "Disclosure consistency check", operations: [operation] });
  assert.doesNotThrow(() => validateGitHubWritePlan(wrap(sample)), `${type} with exactly the disclosed keys must validate`);
  for (const key of keys) {
    const missing = { ...sample };
    delete missing[key];
    assert.throws(() => validateGitHubWritePlan(wrap(missing)), /invalid_input/, `${type} without ${key} must fail validation`);
  }
  assert.throws(() => validateGitHubWritePlan(wrap({ ...sample, unexpected_key: true })), /invalid_input/,
    `${type} with an extra key must fail validation`);
}
assert.throws(() => validateGitHubWritePlan({
  repository: "example/project", summary: "undisclosed operation", operations: [{ type: "delete_file", path: "docs/note.md" }],
}), /unknown_tool/, "Operation types absent from the disclosure must stay unsupported");

console.log("GitHub tools tests passed: read allowlist, bounded writes, approval-plan validation, hashing, path blocking, API failures, and write-plan schema disclosure consistency.");
