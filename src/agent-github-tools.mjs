const MAX_RESULT_CHARS = 40_000;
const MAX_FILE_CHARS = 30_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const PATH_PATTERN = /^[A-Za-z0-9_./@+-]{1,240}$/u;
const BLOCKED_PATH_PARTS = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars|secrets?|credentials?|private[-_]?keys?)(?:\/|$)|\.(?:pem|p12|pfx|key)$/iu;

export const GITHUB_READ_TOOLS = Object.freeze({
  github_get_issue: Object.freeze({
    description: "Read one GitHub issue by owner/repository and issue number. Public repository data only; no writes.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "number"]),
  }),
  github_list_pull_requests: Object.freeze({
    description: "List a bounded set of open or closed pull requests in a GitHub repository.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "state"]),
  }),
  github_get_pull_request: Object.freeze({
    description: "Read one GitHub pull request's metadata and bounded description.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "number"]),
  }),
  github_get_pr_checks: Object.freeze({
    description: "Read the latest check-run status for one GitHub pull request.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "number"]),
  }),
  github_read_file: Object.freeze({
    description: "Read a text file from a public GitHub repository branch. Optional line ranges are supported; sensitive file paths are blocked.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "path", "ref", "start_line", "end_line"]),
  }),
});

function validateRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value) || value.includes("..")) {
    throw new Error("invalid_input");
  }
  return value;
}

function validateNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error("invalid_input");
  return value;
}

function boundedText(value, max = 2_000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function githubGet(path, { token, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl("https://api.github.com" + path, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Akatuki-Knowledge",
      ...(typeof token === "string" && token ? { authorization: "Bearer " + token } : {}),
    },
    signal,
  });
  if (response.status === 404) throw new Error("github_not_found");
  if (response.status === 401 || response.status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") throw new Error("github_rate_limited");
    throw new Error("github_access_denied");
  }
  if (response.status === 429) throw new Error("github_rate_limited");
  if (!response.ok) {
    if (response.status >= 500) throw new Error("github_upstream_error");
    throw new Error("github_request_failed");
  }
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("github_response_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("github_invalid_response");
  }
}


// The description and operationArguments are shown to the model verbatim, so they must
// mirror validateGitHubWritePlan exactly: undisclosed required keys make the model's
// first proposal fail strict validation (Issue #90). scripts/test_agent_github_tools.mjs
// pins this disclosure against the validator.
export const GITHUB_WRITE_PROPOSAL_TOOL = Object.freeze({
  description: "Prepare a GitHub write plan for explicit user approval. This tool NEVER performs writes. "
    + "The arguments object must contain exactly repository, summary, operations. "
    + "operations may contain one or more entries, bounded by the total serialized plan size. Each operation must contain exactly its documented keys. "
    + "create_branch={type,branch,base_ref}; create_file={type,branch,path,content,message}; "
    + "update_file={type,branch,path,content,message,sha}; apply_patch={type,branch,path,patch,message,sha}; "
    + "create_issue={type,title,body}; add_issue_comment={type,number,body}; "
    + "create_pull_request={type,head,base,title,body,draft}. "
    + "File content may be up to 200000 characters. apply_patch uses a standard unified diff for exactly one existing file, with --- a/<path> and +++ b/<path> headers, and is limited to 100000 characters. "
    + "update_file and apply_patch require the current 40-character blob sha. The complete plan must fit within 500000 characters of JSON.",
  sideEffect: "approval_required",
  arguments: Object.freeze(["repository", "summary", "operations"]),
  operationArguments: Object.freeze({
    create_branch: Object.freeze(["type", "branch", "base_ref"]),
    create_file: Object.freeze(["type", "branch", "path", "content", "message"]),
    update_file: Object.freeze(["type", "branch", "path", "content", "message", "sha"]),
    apply_patch: Object.freeze(["type", "branch", "path", "patch", "message", "sha"]),
    create_issue: Object.freeze(["type", "title", "body"]),
    add_issue_comment: Object.freeze(["type", "number", "body"]),
    create_pull_request: Object.freeze(["type", "head", "base", "title", "body", "draft"]),
  }),
});

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const WRITE_PATH_PATTERN = /^[A-Za-z0-9_./@+-]{1,240}$/u;

function validateWritePath(path) {
  if (typeof path !== "string" || !WRITE_PATH_PATTERN.test(path) || path.startsWith("/")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || BLOCKED_PATH_PARTS.test(path)) throw new Error("github_path_blocked");
  return path;
}

function validateBranch(value) {
  if (typeof value !== "string" || !BRANCH_PATTERN.test(value) || value.startsWith("/")
    || value.endsWith("/") || value.includes("..") || value.includes("//")
    || value.endsWith(".lock")) throw new Error("invalid_input");
  return value;
}

function validateShortText(value, max, field) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_input");
  return value.trim();
}

function validateContent(value, max) {
  if (typeof value !== "string" || value.length > max) throw new Error("invalid_input");
  return value;
}

export function validateGitHubWritePlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "operations,repository,summary") throw new Error("invalid_input");
  const repository = validateRepository(input.repository);
  const summary = validateShortText(input.summary, 500, "summary");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 50) {
    throw new Error("invalid_input");
  }
  const operations = input.operations.map((op) => {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.type !== "string") throw new Error("invalid_input");
    switch (op.type) {
      case "create_branch": {
        if (!exactObjectKeys(op, ["type", "branch", "base_ref"])) throw new Error("invalid_input");
        return { type: op.type, branch: validateBranch(op.branch), base_ref: validateBranch(op.base_ref) };
      }
      case "create_file": {
        if (!exactObjectKeys(op, ["type", "branch", "path", "content", "message"])) throw new Error("invalid_input");
        return { type: op.type, branch: validateBranch(op.branch), path: validateWritePath(op.path),
          content: validateContent(op.content, 200_000),
          message: validateShortText(op.message, 200, "message") };
      }
      case "update_file": {
        if (!exactObjectKeys(op, ["type", "branch", "path", "content", "message", "sha"]) || !SHA_PATTERN.test(op.sha)) throw new Error("invalid_input");
        return { type: op.type, branch: validateBranch(op.branch), path: validateWritePath(op.path),
          content: validateContent(op.content, 200_000),
          message: validateShortText(op.message, 200, "message"), sha: op.sha };
      }
      case "apply_patch": {
        if (!exactObjectKeys(op, ["type", "branch", "path", "patch", "message", "sha"]) || !SHA_PATTERN.test(op.sha)) throw new Error("invalid_input");
        return {
          type: op.type,
          branch: validateBranch(op.branch),
          path: validateWritePath(op.path),
          patch: validateContent(op.patch, 100_000),
          message: validateShortText(op.message, 200, "message"),
          sha: op.sha,
        };
      }
      case "create_issue": {
        if (!exactObjectKeys(op, ["type", "title", "body"])) throw new Error("invalid_input");
        return { type: op.type, title: validateShortText(op.title, 200, "title"),
          body: typeof op.body === "string" && op.body.length <= 10_000 ? op.body : (() => { throw new Error("invalid_input"); })() };
      }
      case "add_issue_comment": {
        if (!exactObjectKeys(op, ["type", "number", "body"]) || !Number.isSafeInteger(op.number) || op.number < 1 || op.number > 1_000_000) throw new Error("invalid_input");
        return { type: op.type, number: op.number, body: validateShortText(op.body, 10_000, "body") };
      }
      case "create_pull_request": {
        if (!exactObjectKeys(op, ["type", "head", "base", "title", "body", "draft"])) throw new Error("invalid_input");
        if (typeof op.draft !== "boolean") throw new Error("invalid_input");
        return { type: op.type, head: validateBranch(op.head), base: validateBranch(op.base),
          title: validateShortText(op.title, 200, "title"),
          body: typeof op.body === "string" && op.body.length <= 10_000 ? op.body : (() => { throw new Error("invalid_input"); })(),
          draft: op.draft };
      }
      default: throw new Error("unknown_tool");
    }
  });
  const normalized = { repository, summary, operations };
  if (JSON.stringify(normalized).length > 500_000) throw new Error("github_write_plan_too_large");
  return normalized;
}

function exactObjectKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function decodeBase64Utf8(value) {
  let decoded;
  try { decoded = atob(value.replace(/\n/g, "")); }
  catch { throw new Error("github_invalid_file"); }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("github_invalid_file"); }
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export function applyUnifiedPatch(original, patch, path) {
  const normalizedOriginal = String(original).replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalizedOriginal.endsWith("\n");
  const sourceLines = normalizedOriginal.split("\n");
  if (hadTrailingNewline) sourceLines.pop();
  const patchLines = String(patch).replace(/\r\n/g, "\n").split("\n");
  if (patchLines[0] !== "--- a/" + path || patchLines[1] !== "+++ b/" + path) {
    throw new Error("github_patch_path_mismatch");
  }
  const output = [];
  let sourceIndex = 0;
  let hunks = 0;
  let index = 2;
  while (index < patchLines.length) {
    if (!patchLines[index]) { index++; continue; }
    const match = patchLines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u);
    if (!match) throw new Error("github_patch_invalid");
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const targetIndex = oldStart === 0 ? 0 : oldStart - 1;
    if (targetIndex < sourceIndex || targetIndex > sourceLines.length) throw new Error("github_patch_context_mismatch");
    output.push(...sourceLines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;
    let consumed = 0;
    let produced = 0;
    index++;
    while (index < patchLines.length && patchLines[index] !== "" && !patchLines[index].startsWith("@@ ")) {
      const line = patchLines[index++];
      if (line.startsWith("\\ No newline at end of file")) continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (sourceLines[sourceIndex] !== text) throw new Error("github_patch_context_mismatch");
        output.push(text);
        sourceIndex++;
        consumed++;
        produced++;
      } else if (marker === "-") {
        if (sourceLines[sourceIndex] !== text) throw new Error("github_patch_context_mismatch");
        sourceIndex++;
        consumed++;
      } else if (marker === "+") {
        output.push(text);
        produced++;
      } else {
        throw new Error("github_patch_invalid");
      }
    }
    if (consumed !== oldCount || produced !== newCount) throw new Error("github_patch_invalid");
    hunks++;
  }
  if (hunks === 0) throw new Error("github_patch_invalid");
  output.push(...sourceLines.slice(sourceIndex));
  return output.join("\n") + (hadTrailingNewline ? "\n" : "");
}

export async function hashGitHubWritePlan(plan) {
  const normalized = validateGitHubWritePlan(plan);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function executeGitHubWritePlan(planInput, { token, fetchImpl = fetch, signal } = {}) {
  const plan = validateGitHubWritePlan(planInput);
  if (typeof token !== "string" || !token) throw new Error("github_write_token_missing");
  const results = [];
  for (const op of plan.operations) {
    let path;
    let method = "POST";
    let body;
    if (op.type === "create_branch") {
      const base = await githubGet("/repos/" + plan.repository + "/git/ref/heads/" + op.base_ref.split("/").map(encodeURIComponent).join("/"), { token, fetchImpl, signal });
      path = "/repos/" + plan.repository + "/git/refs";
      body = { ref: "refs/heads/" + op.branch, sha: base.object?.sha };
      if (!body.sha) throw new Error("github_invalid_response");
    } else if (op.type === "create_file" || op.type === "update_file") {
      path = "/repos/" + plan.repository + "/contents/" + op.path.split("/").map(encodeURIComponent).join("/");
      method = "PUT";
      body = { message: op.message, content: encodeBase64Utf8(op.content), branch: op.branch };
      if (op.type === "update_file") body.sha = op.sha;
    } else if (op.type === "apply_patch") {
      const filePath = "/repos/" + plan.repository + "/contents/" + op.path.split("/").map(encodeURIComponent).join("/");
      const current = await githubGet(filePath + "?ref=" + encodeURIComponent(op.branch), { token, fetchImpl, signal });
      if (current.type !== "file" || current.encoding !== "base64" || current.sha !== op.sha
        || typeof current.content !== "string" || current.size > 1_000_000) {
        throw new Error("github_write_conflict");
      }
      const currentContent = decodeBase64Utf8(current.content);
      const patchedContent = applyUnifiedPatch(currentContent, op.patch, op.path);
      if (patchedContent.length > 1_000_000) throw new Error("github_file_too_large");
      path = filePath;
      method = "PUT";
      body = { message: op.message, content: encodeBase64Utf8(patchedContent), branch: op.branch, sha: current.sha };
    } else if (op.type === "create_issue") {
      path = "/repos/" + plan.repository + "/issues";
      body = { title: op.title, body: op.body };
    } else if (op.type === "add_issue_comment") {
      path = "/repos/" + plan.repository + "/issues/" + op.number + "/comments";
      body = { body: op.body };
    } else if (op.type === "create_pull_request") {
      path = "/repos/" + plan.repository + "/pulls";
      body = { title: op.title, body: op.body, head: op.head, base: op.base, draft: op.draft };
    } else {
      throw new Error("unknown_tool");
    }
    const response = await fetchImpl("https://api.github.com" + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Akatuki-Knowledge",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("github_write_access_denied");
    if (response.status === 404) throw new Error("github_write_target_not_found");
    if (response.status === 409 || response.status === 422) throw new Error("github_write_conflict");
    if (response.status === 429) throw new Error("github_rate_limited");
    if (!response.ok) throw new Error(response.status >= 500 ? "github_upstream_error" : "github_write_failed");
    let data;
    try { data = await response.json(); } catch { throw new Error("github_invalid_response"); }
    results.push({
      operation: op.type,
      number: Number.isSafeInteger(data.number) ? data.number : null,
      branch: typeof data.ref === "string" ? data.ref.replace(/^refs\/heads\//u, "") : (op.branch || null),
      path: typeof data.content?.path === "string" ? data.content.path : (op.path || null),
      url: safeUrl(data.html_url || data.content?.html_url || data._links?.html?.href),
      sha: typeof data.commit?.sha === "string" ? data.commit.sha : null,
    });
  }
  return { repository: plan.repository, results };
}

export async function executeGitHubReadTool(tool, args, options = {}) {
  if (!Object.hasOwn(GITHUB_READ_TOOLS, tool)) throw new Error("unknown_tool");
  const repository = validateRepository(args?.repository);
  let result;
  if (tool === "github_get_issue") {
    validateNumber(args.number);
    const issue = await githubGet(`/repos/${repository}/issues/${args.number}`, options);
    result = {
      kind: issue.pull_request ? "pull_request" : "issue",
      repository,
      number: issue.number,
      title: boundedText(issue.title, 300),
      state: boundedText(issue.state, 30),
      body: boundedText(issue.body, 4_000),
      url: safeUrl(issue.html_url),
      createdAt: boundedText(issue.created_at, 40),
      updatedAt: boundedText(issue.updated_at, 40),
      labels: Array.isArray(issue.labels) ? issue.labels.slice(0, 20).map((label) => boundedText(label?.name, 100)) : [],
    };
  } else if (tool === "github_list_pull_requests") {
    if (!["open", "closed", "all"].includes(args.state)) throw new Error("invalid_input");
    const pulls = await githubGet(`/repos/${repository}/pulls?state=${args.state}&per_page=10&sort=updated&direction=desc`, options);
    if (!Array.isArray(pulls)) throw new Error("github_invalid_response");
    result = {
      repository,
      pullRequests: pulls.slice(0, 10).map((pr) => ({
        number: pr.number,
        title: boundedText(pr.title, 300),
        state: boundedText(pr.state, 30),
        draft: pr.draft === true,
        merged: pr.merged_at != null,
        head: boundedText(pr.head?.ref, 200),
        base: boundedText(pr.base?.ref, 200),
        url: safeUrl(pr.html_url),
        updatedAt: boundedText(pr.updated_at, 40),
      })),
    };
  } else if (tool === "github_get_pull_request") {
    validateNumber(args.number);
    const pr = await githubGet(`/repos/${repository}/pulls/${args.number}`, options);
    result = {
      repository,
      number: pr.number,
      title: boundedText(pr.title, 300),
      state: boundedText(pr.state, 30),
      draft: pr.draft === true,
      merged: pr.merged_at != null,
      body: boundedText(pr.body, 4_000),
      head: boundedText(pr.head?.ref, 200),
      base: boundedText(pr.base?.ref, 200),
      url: safeUrl(pr.html_url),
      updatedAt: boundedText(pr.updated_at, 40),
      changedFiles: Number.isSafeInteger(pr.changed_files) ? pr.changed_files : null,
      additions: Number.isSafeInteger(pr.additions) ? pr.additions : null,
      deletions: Number.isSafeInteger(pr.deletions) ? pr.deletions : null,
    };
  } else if (tool === "github_get_pr_checks") {
    validateNumber(args.number);
    const pr = await githubGet(`/repos/${repository}/pulls/${args.number}`, options);
    const checks = await githubGet(`/repos/${repository}/commits/${pr.head?.sha}/check-runs?per_page=20`, options);
    if (!Array.isArray(checks.check_runs)) throw new Error("github_invalid_response");
    result = {
      repository,
      number: pr.number,
      title: boundedText(pr.title, 300),
      headSha: boundedText(pr.head?.sha, 100),
      url: safeUrl(pr.html_url),
      totalCount: Number.isSafeInteger(checks.total_count) ? checks.total_count : checks.check_runs.length,
      checks: checks.check_runs.slice(0, 20).map((check) => ({
        name: boundedText(check.name, 200),
        status: boundedText(check.status, 30),
        conclusion: check.conclusion == null ? null : boundedText(check.conclusion, 40),
        url: safeUrl(check.html_url),
      })),
    };
  } else {
    if (typeof args.path !== "string" || !PATH_PATTERN.test(args.path)
      || args.path.startsWith("/") || args.path.split("/").some((part) => !part || part === "." || part === "..")
      || BLOCKED_PATH_PARTS.test(args.path)) {
      throw new Error("github_path_blocked");
    }
    const ref = args.ref === "" ? "" : args.ref;
    if (typeof ref !== "string" || ref.length > 120 || (ref && !/^[A-Za-z0-9_./-]+$/u.test(ref))
      || ref.split("/").includes("..")) throw new Error("invalid_input");
    const query = ref ? "?ref=" + encodeURIComponent(ref) : "";
    const file = await githubGet(`/repos/${repository}/contents/${args.path.split("/").map(encodeURIComponent).join("/")}${query}`, options);
    if (file.type !== "file" || typeof file.content !== "string" || file.encoding !== "base64") {
      throw new Error("github_not_text_file");
    }
    if (file.size > 1_000_000) throw new Error("github_file_too_large");
    const content = decodeBase64Utf8(file.content);
    if (content.includes("\u0000")) throw new Error("github_not_text_file");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const totalLines = lines.length;
    const startLine = args.start_line === undefined ? 1 : validateNumber(args.start_line);
    const endLine = args.end_line === undefined ? Math.min(totalLines, startLine + 999) : validateNumber(args.end_line);
    if (endLine < startLine || endLine - startLine > 999 || startLine > totalLines + 1) throw new Error("invalid_input");
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    result = {
      repository,
      path: args.path,
      ref: boundedText(ref || file.target || "", 120),
      sha: boundedText(file.sha, 100),
      url: safeUrl(file.html_url),
      totalLines,
      startLine,
      endLine: Math.min(endLine, totalLines),
      truncated: selected.length > MAX_FILE_CHARS || endLine < totalLines,
      content: selected.slice(0, MAX_FILE_CHARS),
    };
  }
  if (JSON.stringify(result).length > MAX_RESULT_CHARS) throw new Error("github_result_too_large");
  return result;
}
