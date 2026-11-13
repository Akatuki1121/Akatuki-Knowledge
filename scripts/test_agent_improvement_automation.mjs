import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { callWorkersAi, WORKERS_AI_MODEL, WORKERS_AI_MAX_OUTPUT_TOKENS } from "../src/workers-ai-client.mjs";
import { IMPROVEMENT_TASK_MAX_OUTPUT_TOKENS, IMPROVEMENT_TASK_REASONING_EFFORT } from "../src/task-runtime-config.mjs";
import { executeApprovedImprovementPlan } from "../src/agent-improvement-executor.mjs";
import { validateImprovementPlan, improvementIdempotencyKey, stripImprovementResults } from "../src/agent-improvement-policy.mjs";
import { hashGitHubWritePlan } from "../src/agent-github-tools.mjs";

function createBudgetDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE workers_ai_daily_usage (
    usage_day TEXT PRIMARY KEY,
    reserved_neurons INTEGER NOT NULL DEFAULT 0,
    actual_neurons INTEGER NOT NULL DEFAULT 0,
    calls_completed INTEGER NOT NULL DEFAULT 0,
    calls_failed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  return {
    get(sql, ...values) { return sqlite.prepare(sql).get(...values) ?? null; },
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values) ?? null; },
        run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        }
      };
    }
  };
}

const validPlan = () => ({
  repository: "Akatuki1121/Akatuki-Knowledge",
  summary: "検査対象の小さな修正",
  operations: [
    { type: "create_branch", branch: "agent/fix-small-check", base_ref: "main" },
    { type: "create_file", branch: "agent/fix-small-check", path: "src/example.mjs", content: "export const ok = true;\n", message: "修正を追加" },
    { type: "create_pull_request", head: "agent/fix-small-check", base: "main", title: "修正を追加", body: "自動化テスト用", draft: false }
  ]
});

test("Workers AI client uses the model context window and returns text", async () => {
  let called;
  let usageSeen = null;
  const env = { DB: createBudgetDb(), AI: { run: async (...args) => { called = args; return {
    response: '{"action":"final","reply":"ok","source_ids":[]}',
    usage: { prompt_tokens: 20, completion_tokens: 5 }
  }; } } };
  const result = await callWorkersAi(env, "prompt", 500, {
    responseMimeType: "application/json",
    reasoningEffort: IMPROVEMENT_TASK_REASONING_EFFORT,
    onUsage: async (usage) => { usageSeen = usage; }
  });
  assert.equal(result, '{"action":"final","reply":"ok","source_ids":[]}');
  assert.equal(WORKERS_AI_MODEL, "@cf/zai-org/glm-4.7-flash");
  assert.equal(called[0], WORKERS_AI_MODEL);
  assert.equal(called[1].max_completion_tokens, 500);
  assert.equal(called[1].reasoning_effort, "high");
  assert.deepEqual(called[1].response_format, { type: "json_object" });
  assert.equal(WORKERS_AI_MAX_OUTPUT_TOKENS, 131072);
  assert.equal(IMPROVEMENT_TASK_MAX_OUTPUT_TOKENS, 8192);
  assert.equal(IMPROVEMENT_TASK_REASONING_EFFORT, "high");
  assert.deepEqual(usageSeen, { prompt_tokens: 20, completion_tokens: 5 });
});

test("Workers AI client extracts the GLM-4.7-Flash chat completion fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/glm-4.7-flash-responses.json", import.meta.url), "utf8"));
  let usageSeen = null;
  const env = { DB: createBudgetDb(), AI: { run: async () => fixture.completed } };
  const result = await callWorkersAi(env, "prompt", 2048, {
    responseMimeType: "application/json",
    reasoningEffort: IMPROVEMENT_TASK_REASONING_EFFORT,
    onUsage: async (usage) => { usageSeen = usage; }
  });
  assert.equal(result, fixture.completed.choices[0].message.content);
  assert.equal(result, '{"ok":true}');
  assert.equal(usageSeen.prompt_tokens, 36);
  assert.equal(usageSeen.completion_tokens, 180);
});

test("Workers AI client records response shape and completion stage without exposing reasoning", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/glm-4.7-flash-responses.json", import.meta.url), "utf8"));
  const env = { DB: createBudgetDb(), AI: { run: async () => fixture.truncated } };
  await assert.rejects(
    callWorkersAi(env, "prompt", 128, { responseMimeType: "application/json" }),
    (error) => {
      assert.equal(error.reason, "workers_ai_invalid_response");
      assert.match(error.message, /stage=completion/);
      assert.match(error.message, /shape=chat.completion/);
      assert.match(error.message, /finish=length/);
      assert.match(error.message, /content=null/);
      assert.match(error.message, /reasoning=/);
      assert.doesNotMatch(error.message, /redacted reasoning text/);
      return true;
    }
  );
});

test("Workers AI client preserves sanitized upstream failure and keeps stable reason", async () => {
  const upstream = new Error("quota exceeded for model");
  upstream.name = "WorkersAiError";
  upstream.code = "model_error";
  const env = { DB: createBudgetDb(), AI: { run: async () => { throw upstream; } } };
  await assert.rejects(
    callWorkersAi(env, "prompt", 500, { responseMimeType: "application/json" }),
    (error) => {
      assert.ok(error.message.startsWith("workers_ai_request_failed"));
      assert.equal(error.reason, "workers_ai_request_failed");
      assert.match(error.message, /quota exceeded/);
      assert.match(error.message, /model_error/);
      assert.deepEqual(error.workersAiError, { name: "WorkersAiError", message: "quota exceeded for model", code: "model_error" });
      assert.equal(error.cause, upstream);
      return true;
    }
  );
});

test("Workers AI request failures record elapsed time and the effective per-call cap", async () => {
  const upstream = new Error("AiError: 3046: Request timeout");
  const env = { DB: createBudgetDb(), AI: { run: async () => { throw upstream; } } };
  await assert.rejects(callWorkersAi(env, "prompt", IMPROVEMENT_TASK_MAX_OUTPUT_TOKENS, {
    responseMimeType: "application/json", reasoningEffort: IMPROVEMENT_TASK_REASONING_EFFORT,
  }), (error) => {
    assert.equal(error.reason, "workers_ai_request_failed");
    assert.match(error.message, /elapsed_ms=\d+/);
    assert.match(error.message, /max_tokens=8192/);
    assert.match(error.message, /reasoning=high/);
    assert.ok(Number.isSafeInteger(error.workersAiDurationMs));
    return true;
  });
});

test("Workers AI client settles response-less failures as input-only usage", async () => {
  const db = createBudgetDb();
  let failureUsage = null;
  const upstream = new Error("HTTP 503 upstream unavailable");
  const env = { DB: db, AI: { run: async () => { throw upstream; } } };
  await assert.rejects(
    callWorkersAi(env, "prompt", 500, {
      onFailure: async (usage) => { failureUsage = usage; }
    }),
    (error) => error.reason === "workers_ai_request_failed"
  );
  assert.ok(Number.isSafeInteger(failureUsage?.inputTokens) && failureUsage.inputTokens > 0);
  const row = db.get("SELECT reserved_neurons, actual_neurons, calls_completed, calls_failed FROM workers_ai_daily_usage");
  assert.equal(row.reserved_neurons, 0);
  assert.ok(row.actual_neurons > 0);
  assert.equal(row.calls_completed, 0);
  assert.equal(row.calls_failed, 1);
});

test("Workers AI client does not pass signal to AI.run", async () => {
  let called;
  const env = { DB: createBudgetDb(), AI: { run: async (...args) => { called = args; return { response: "ok" }; } } };
  const result = await callWorkersAi(env, "prompt", 500, { responseMimeType: "application/json", signal: AbortSignal.timeout(1000) });
  assert.equal(result, "ok");
  assert.equal(called.length, 2);
  assert.equal("signal" in called[1], false);
  assert.deepEqual(called[1].response_format, { type: "json_object" });
});

test("Workers AI client truncates and redacts sanitized failure messages", async () => {
  const upstream = new Error(`failed api_key=secret-token-123 ${"y".repeat(300)}`);
  upstream.code = 429;
  const env = { DB: createBudgetDb(), AI: { run: async () => { throw upstream; } } };
  await assert.rejects(
    callWorkersAi(env, "prompt", 500),
    (error) => {
      assert.ok(error.message.startsWith("workers_ai_request_failed"));
      assert.equal(error.workersAiError.code, 429);
      assert.ok(error.workersAiError.message.length <= 200);
      assert.match(error.workersAiError.message, /api_key=\[redacted\]/);
      assert.doesNotMatch(error.message, /secret-token-123/);
      return true;
    }
  );
});

test("improvement plan allows pending migrations and safe workflows but protects deployment controls", () => {
  const plan = validPlan();
  plan.operations[1].path = ".github/workflows/deploy.yml";
  assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
  plan.operations[1].path = "migrations/0014.sql";
  assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
  plan.operations[1].path = "migrations/pending/0019_audit.sql";
  assert.equal(validateImprovementPlan(plan).ok, true);
  plan.operations[1].path = "tests/agent-improvement/new-check.mjs";
  assert.equal(validateImprovementPlan(plan).ok, true);
  plan.operations[1].path = ".github/workflows/audit-report.yml";
  plan.operations[1].content = ["name: Audit", "on:", "  schedule:", "    - cron: 0 0 * * *", "permissions:", "  contents: read"].join("\n");
  assert.equal(validateImprovementPlan(plan).ok, true);
  plan.operations[1].content += "\n" + ["permissions:", "  contents: write"].join("\n");
  assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
  const patchPlan = validPlan();
  patchPlan.operations[1] = {
    type: "apply_patch", branch: "agent/fix-small-check", path: "src/index.js",
    patch: "--- a/src/index.js\\n+++ b/src/index.js\\n@@ -1,1 +1,1 @@\\n-old\\n+new\\n",
    message: "差分修正", sha: "a".repeat(40),
  };
  assert.equal(validateImprovementPlan(patchPlan).ok, true);
});

test("improvement plan rejects guardrail files with changed_path_protected", () => {
  const protectedPaths = [
    "src/background-task-policy.mjs",
    "src/background-task-store.mjs",
    "src/agent-improvement-policy.mjs",
    "src/agent-improvement-executor.mjs",
    "src/budget-self-audit.mjs",
    "src/task-runtime-config.mjs",
  ];
  for (const path of protectedPaths) {
    const plan = validPlan();
    plan.operations[1] = {
      type: "update_file", branch: "agent/fix-small-check", path,
      content: "export const changed = true;\n", message: "歯止めを変更", sha: "a".repeat(40),
    };
    assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_protected" }, path);
  }
  const patchPlan = validPlan();
  patchPlan.operations[1] = {
    type: "apply_patch", branch: "agent/fix-small-check", path: "src/task-runtime-config.mjs",
    patch: "--- a/src/task-runtime-config.mjs\n+++ b/src/task-runtime-config.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    message: "上限を変更", sha: "a".repeat(40),
  };
  assert.deepEqual(validateImprovementPlan(patchPlan), { ok: false, reason: "changed_path_protected" });
  const normalPlan = validPlan();
  normalPlan.operations[1] = {
    type: "update_file", branch: "agent/fix-small-check", path: "src/index.js",
    content: "export const ok = true;\n", message: "通常の修正", sha: "a".repeat(40),
  };
  assert.equal(validateImprovementPlan(normalPlan).ok, true);
});

test("improvement request fixture uses current frontmatter-free heading format", async () => {
  const note = [
    "## 何が困っているか",
    "",
    "GitHub の改善依頼が人の承認待ちで止まり、端末を起こすまで進まない。",
    "",
    "## どうなっていてほしいか",
    "",
    "許可された変更範囲なら、PR 作成と CI 待ちの自動マージ設定まで進んでほしい。",
    "",
    "## どうなれば直ったと言えるか",
    "",
    "同じ content_hash は二重起票されず、結果がこのノートに記録される。"
  ].join("\n");
  assert.match(note, /^## 何が困っているか/m);
  assert.match(note, /^## どうなっていてほしいか/m);
  assert.match(note, /^## どうなれば直ったと言えるか/m);
  assert.doesNotMatch(note, /^id:\s/m);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(note))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await improvementIdempotencyKey("fixture-sync-uuid", digest), await improvementIdempotencyKey("fixture-sync-uuid", digest));
});

test("idempotency key is stable and bounded for sync UUID plus content hash", async () => {
  const hash = "a".repeat(64);
  const first = await improvementIdempotencyKey("sync-uuid", hash);
  assert.equal(first, await improvementIdempotencyKey("sync-uuid", hash));
  assert.notEqual(first, await improvementIdempotencyKey("other-uuid", hash));
  assert.ok(first.length <= 100);
  const expanded = validPlan();
  expanded.operations[1].path = "migrations/pending/0019_audit.sql";
  assert.equal(validateImprovementPlan(expanded).ok, true);
});

test("eligible plan creates PR and enables squash auto-merge through mocked GitHub calls", async () => {
  const plan = validPlan();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "a".repeat(40) } });
    if (String(url).endsWith("/git/refs")) return Response.json({ ref: "refs/heads/agent/fix-small-check" });
    if (String(url).includes("/contents/src/example.mjs")) return Response.json({ content: { path: "src/example.mjs", html_url: "https://github.com/Akatuki1121/Akatuki-Knowledge/blob/agent/fix-small-check/src/example.mjs" }, commit: { sha: "b".repeat(40) } });
    if (String(url).endsWith("/pulls") && options.method === "POST") return Response.json({ number: 42, html_url: "https://github.com/Akatuki1121/Akatuki-Knowledge/pull/42" });
    if (String(url).endsWith("/pulls/42")) return Response.json({ node_id: "PR_node_id" });
    if (String(url).endsWith("/graphql")) return Response.json({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 42 } } } });
    throw new Error("unexpected_mock_request");
  };
  const result = await executeApprovedImprovementPlan({ plan, expectedPlanHash: await hashGitHubWritePlan(plan), token: "test-token", fetchImpl });
  assert.deepEqual(result, { ok: true, pullRequestUrl: "https://github.com/Akatuki1121/Akatuki-Knowledge/pull/42", autoMergeEnabled: true });
  assert.ok(calls.some((call) => call.url.endsWith("/graphql") && call.body.variables.input.mergeMethod === "SQUASH"));
});

test("already-enabled squash auto-merge is idempotent", async () => {
  const plan = validPlan();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "a".repeat(40) } });
    if (String(url).endsWith("/git/refs")) return Response.json({ ref: "refs/heads/agent/fix-small-check" });
    if (String(url).includes("/contents/src/example.mjs")) return Response.json({ content: { path: "src/example.mjs" }, commit: { sha: "b".repeat(40) } });
    if (String(url).endsWith("/pulls") && options.method === "POST") return Response.json({ number: 43, html_url: "https://github.com/Akatuki1121/Akatuki-Knowledge/pull/43" });
    if (String(url).endsWith("/pulls/43")) return Response.json({
      node_id: "PR_node_id",
      auto_merge: { enabled_at: "2026-10-30T00:00:00Z", merge_method: "squash" },
    });
    if (String(url).endsWith("/graphql")) throw new Error("GraphQL must not be called when auto-merge is already enabled");
    throw new Error("unexpected_mock_request");
  };
  const result = await executeApprovedImprovementPlan({ plan, expectedPlanHash: await hashGitHubWritePlan(plan), token: "test-token", fetchImpl });
  assert.deepEqual(result, {
    ok: true,
    pullRequestUrl: "https://github.com/Akatuki1121/Akatuki-Knowledge/pull/43",
    autoMergeEnabled: true,
  });
  assert.equal(calls.some((call) => call.url.endsWith("/graphql")), false);
});

test("rejected plan and hash mismatch make no GitHub calls", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("should_not_call"); };
  const plan = validPlan();
  plan.operations[1].path = ".github/workflows/auto-merge.yml";
  assert.deepEqual(await executeApprovedImprovementPlan({ plan, expectedPlanHash: "unused", token: "test-token", fetchImpl }), { ok: false, reason: "changed_path_out_of_scope" });
  const allowed = validPlan();
  assert.deepEqual(await executeApprovedImprovementPlan({ plan: allowed, expectedPlanHash: "wrong-hash", token: "test-token", fetchImpl }), { ok: false, reason: "approved_plan_hash_mismatch" });
  assert.equal(calls, 0);
});

test("improvement result blocks are removed before retrying the original request", () => {
  const original = "## 困っていること\n\n確認してほしい。";
  const withResult = original + "\n\n<!-- akatuki-improvement-result:task-1 -->\n### 改善エージェント実行結果\n\n\x60\x60\x60json\n{\"status\":\"failed\"}\n\x60\x60\x60\n";
  const withTwoResults = withResult + "\n<!-- akatuki-improvement-result:task-2 -->\n### 改善エージェント実行結果\n\n\x60\x60\x60json\n{\"status\":\"failed\"}\n\x60\x60\x60\n";
  assert.equal(stripImprovementResults(withResult), original);
  assert.equal(stripImprovementResults(withTwoResults), original);
  assert.equal(stripImprovementResults(original), original);
});

test("improvement result blocks carrying an escalation are removed before retrying the original request", () => {
  const original = "## 困っていること\n\n確認してほしい。";
  const escalationResult = {
    taskId: "task-9",
    status: "needs_attention",
    pullRequestUrl: null,
    autoMergeEnabled: false,
    reason: "invalid_input",
    error: "Error: invalid_input:model_response_not_json",
    recordedAt: "2026-11-14T00:00:00.000Z",
    escalation: {
      errorClass: "invalid_input",
      stopReason: "non_retryable_invalid_input",
      attempts: 4,
      retryPolicyVersion: 8,
      recordedAt: "2026-11-14T00:00:00.000Z"
    }
  };
  const withEscalation = original + "\n\n<!-- akatuki-improvement-result:task-9 -->\n### 改善エージェント実行結果\n\n\x60\x60\x60json\n"
    + JSON.stringify(escalationResult) + "\n\x60\x60\x60\n";
  assert.equal(stripImprovementResults(withEscalation), original);
  assert.equal(stripImprovementResults(original), original);
});

test("terminal improvement failures write back an escalation for Muse triage", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const appendStart = source.indexOf("async function appendImprovementResult");
  const inboxStart = source.indexOf("async function runImprovementInbox", appendStart);
  assert.ok(appendStart >= 0 && inboxStart > appendStart);
  const append = source.slice(appendStart, inboxStart);
  assert.ok(append.includes('result.escalation && typeof result.escalation === "object"'),
    "Escalation is opt-in per result so completed/stopped writebacks keep their current shape");
  for (const field of ["errorClass", "stopReason", "attempts", "retryPolicyVersion"]) {
    assert.ok(append.includes(field + ":"), "Escalation carries " + field);
  }
  assert.ok(append.includes("recordedAt"), "Escalation carries recordedAt");
  const workflowStart = source.indexOf("if (failure.status === \"needs_attention\")");
  assert.ok(workflowStart >= 0);
  const terminalWriteback = source.slice(workflowStart, workflowStart + 1600);
  assert.ok(terminalWriteback.includes('status: "needs_attention"'));
  assert.ok(terminalWriteback.includes("escalation: {"));
  assert.ok(terminalWriteback.includes("stopReason: terminalTask.stop_reason || failure.decision?.stopReason || null"));
  assert.ok(terminalWriteback.includes("retryPolicyVersion: Number.isFinite(terminalTask.retry_policy_version)"));
});

test("self-audit notes are handed to Muse instead of being queued as improvement tasks", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const appendStart = source.indexOf("async function appendImprovementResult");
  const inboxStart = source.indexOf("async function runImprovementInbox", appendStart);
  const recoveryStart = source.indexOf("async function recoverAgentTaskWorkflows", inboxStart);
  assert.ok(appendStart >= 0 && inboxStart > appendStart && recoveryStart > inboxStart);
  const append = source.slice(appendStart, inboxStart);
  const inbox = source.slice(inboxStart, recoveryStart);
  assert.ok(append.includes('result.handoff && typeof result.handoff === "object"'),
    "The writeback carries a dedicated handoff field, distinct from escalation");
  for (const field of ["kind", "reason"]) {
    assert.ok(append.includes(field + ":"), "Handoff carries " + field);
  }
  assert.ok(inbox.includes("function improvementNoteFrontmatter") || source.includes("function improvementNoteFrontmatter"),
    "The routing decision reads the note frontmatter");
  assert.ok(inbox.includes('frontmatter.audit_generated === "true"'));
  assert.ok(inbox.includes('frontmatter.origin === "budget-audit"'));
  assert.ok(inbox.includes("audit_frontmatter_unreadable"),
    "An audit-path note whose frontmatter cannot be read fails closed instead of being queued");
  assert.ok(inbox.includes('status: "handed_off"'));
  assert.ok(inbox.includes('kind: "budget_self_audit_note"'));
  assert.ok(inbox.includes('"handoff-" + idempotencyKey'), "The handoff writeback uses a stable per-note record id");
  const routingAt = inbox.indexOf('frontmatter.audit_generated === "true"');
  const enqueueAt = inbox.indexOf("enqueueAgentTask(env.DB");
  assert.ok(routingAt >= 0 && enqueueAt > routingAt, "Audit routing runs before task admission");
});

test("improvement result blocks carrying a handoff are removed before retrying the original request", () => {
  const original = "## 困っていること\n\n確認してほしい。";
  const handoffResult = {
    taskId: "handoff-abc",
    status: "handed_off",
    pullRequestUrl: null,
    autoMergeEnabled: false,
    reason: null,
    error: null,
    recordedAt: "2026-11-14T00:00:00.000Z",
    handoff: {
      kind: "budget_self_audit_note",
      reason: "audit_generated",
      recordedAt: "2026-11-14T00:00:00.000Z"
    }
  };
  const withHandoff = original + "\n\n<!-- akatuki-improvement-result:handoff-abc -->\n### 改善エージェント実行結果\n\n\x60\x60\x60json\n"
    + JSON.stringify(handoffResult) + "\n\x60\x60\x60\n";
  assert.equal(stripImprovementResults(withHandoff), original);
});

test("failed improvement tasks remain unchanged until edited; transient retries use the task retry schedule", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const storeSource = await readFile(new URL("../src/background-task-store.mjs", import.meta.url), "utf8");
  const appendStart = source.indexOf("async function appendImprovementResult");
  const inboxStart = source.indexOf("async function runImprovementInbox", appendStart);
  const recoveryStart = source.indexOf("async function recoverAgentTaskWorkflows", inboxStart);
  assert.ok(appendStart >= 0 && inboxStart > appendStart && recoveryStart > inboxStart);
  const append = source.slice(appendStart, inboxStart);
  const inbox = source.slice(inboxStart, recoveryStart);
  assert.ok(append.includes('if (result?.status === "failed") return false;'));
  assert.ok(inbox.includes('sameRequest && previous && ["failed", "needs_attention"].includes(previous.status)'));
  assert.ok(inbox.includes("reassessImprovementAgentTask"));
  assert.ok(source.includes("async function reassessOutdatedImprovementTasks"));
  assert.ok(source.includes("listReassessableImprovementAgentTasks"));
  assert.ok(storeSource.includes("superseded_by_newer_task"));
  assert.ok(storeSource.includes("normalizeImprovementTaskRuntimePayload"));
  assert.ok(storeSource.includes("status IN ('failed', 'needs_attention', 'queued', 'waiting')"));
  assert.ok(source.includes("previousPayload.prompt.trimEnd() === requestContent.trimEnd()"));
  assert.ok(source.includes("var IMPROVEMENT_RETRY_POLICY_VERSION = 8;"));
  assert.ok(append.includes("isModelResponseShapeInvalidInput"),
    "The terminal sweep must revive model response-shape failures at reassessment");
  assert.ok(inbox.includes("isModelResponseShapeInvalidInput"),
    "The inbox reassessment must apply the same response-shape exception");
  assert.ok(source.includes("const adaptiveMaxOutputTokens = responseAttempt === 0"));
  assert.ok(source.includes("const adaptiveReasoningEffort = responseAttempt === 0"));
  assert.ok(source.includes("const adaptiveResponseMimeType = responseAttempt >= 2"));
  assert.ok(source.includes("retries: { limit: 0, delay: \"1 second\" }"),
    "Workers AI completion failures must reach adaptive recovery without identical step retries");
  assert.ok(inbox.includes("IMPROVEMENT_RETRY_POLICY_VERSION"));
  assert.ok(inbox.includes("retryPolicyVersion: IMPROVEMENT_RETRY_POLICY_VERSION"), "New improvement tasks must start at the current policy version");
  assert.ok(inbox.includes('"needs_attention"'));
  assert.ok(inbox.includes("requeueAgentTaskAfterBudgetWait"));
  assert.ok(inbox.includes("reserveQueuedAgentTaskBudget"));
  assert.ok(!inbox.includes('":retry:" + day'));
  assert.ok(inbox.includes("maxAttempts: 4"));
  assert.ok(inbox.includes("maxTaskAgeMs: 8 * 60 * 60 * 1000"));
  assert.ok(inbox.includes('["queued", "running", "waiting"].includes(previous.status)'));
  assert.ok(!inbox.includes("await markImprovementSeen(env, note.sync_uuid, note.content_hash);\n      const task = admitted.task;"),
    "Queue admission must not mark an improvement request as seen");
  assert.ok(inbox.includes("Leave the note un-seen. A later scheduled scan can try again."));
});


test("manual and scheduled pulls share the same post-pull automation", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const helperStart = source.indexOf("async function runPostPullAutomation");
  const helperEnd = source.indexOf("async function runScheduledMaintenance", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(helper.includes('doFetch(env, "reconcile-existing-note-ids")'));
  assert.ok(helper.includes("runImprovementInbox(env)"));
  assert.ok(helper.includes('skipped: "vault_pull_failed"'));

  const manualStart = source.indexOf('if (url.pathname === "/sync/pull"');
  const scheduledStart = source.indexOf("async scheduled(event, env, ctx)");
  const manual = source.slice(manualStart, scheduledStart);
  const scheduled = source.slice(scheduledStart);
  assert.ok(manual.includes("runPostPullAutomation(env, result.ok === true && result.applied === true)"));
  assert.ok(manual.includes("if (apply) await drainSyncOutbox(env, 10)"));
  assert.ok(scheduled.includes("runPostPullAutomation(env, improvementPullReady)"));
  assert.equal((source.match(/await runPostPullAutomation\(env,/gu) || []).length, 2);
});


test("new self-generated workflows require explicit read-only token permissions", () => {
  const plan = validPlan();
  plan.operations[1].path = ".github/workflows/readonly.yml";
  plan.operations[1].content = [
    "name: Read-only automation",
    "on: push",
    "permissions: read-all",
    "jobs:",
    "  inspect:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo inspect",
    ""
  ].join("\n");
  assert.equal(validateImprovementPlan(plan).ok, true);

  for (const unsafe of [
    ["name: Missing permissions", "on: push", "jobs:", "  inspect:", "    runs-on: ubuntu-latest", ""],
    ["name: Write permission", "on: push", "permissions:", "  contents: write", "jobs:", "  inspect:", "    runs-on: ubuntu-latest", ""],
    ["name: Dangerous trigger", "on: pull_request_target", "permissions: read-all", "jobs:", "  inspect:", "    runs-on: ubuntu-latest", ""],
    ["name: Secret access", "on: push", "permissions: read-all", "jobs:", "  inspect:", "    runs-on: ubuntu-latest", "    env:", "      TOKEN: \${{ secrets.GITHUB_TOKEN }}", ""],
  ]) {
    plan.operations[1].content = unsafe.join("\n");
    assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
  }
});
