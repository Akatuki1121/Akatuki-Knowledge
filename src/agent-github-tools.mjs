const MAX_RESULT_CHARS = 10_000;
const MAX_FILE_CHARS = 8_000;
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
  github_read_file: Object.freeze({
    description: "Read a bounded text file from a public GitHub repository's branch. Sensitive file paths are blocked.",
    sideEffect: "external_read",
    arguments: Object.freeze(["repository", "path", "ref"]),
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
  if (text.length > 100_000) throw new Error("github_response_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("github_invalid_response");
  }
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
    if (file.size > MAX_FILE_CHARS * 4) throw new Error("github_file_too_large");
    let decoded;
    try {
      decoded = atob(file.content.replace(/\n/g, ""));
    } catch {
      throw new Error("github_invalid_file");
    }
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\u0000")) throw new Error("github_not_text_file");
    result = {
      repository,
      path: args.path,
      ref: boundedText(ref || file.target || "", 120),
      sha: boundedText(file.sha, 100),
      url: safeUrl(file.html_url),
      truncated: content.length > MAX_FILE_CHARS,
      content: content.slice(0, MAX_FILE_CHARS),
    };
  }
  if (JSON.stringify(result).length > MAX_RESULT_CHARS) throw new Error("github_result_too_large");
  return result;
}
