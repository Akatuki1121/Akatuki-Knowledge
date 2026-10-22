import assert from "node:assert/strict";
import { executeGitHubReadTool, GITHUB_READ_TOOLS } from "../src/agent-github-tools.mjs";

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

console.log("GitHub read tool tests passed: allowlist, bounded reads, path blocking, and API failures.");
