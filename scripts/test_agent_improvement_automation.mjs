import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { callWorkersAi, WORKERS_AI_MODEL, WORKERS_AI_MAX_OUTPUT_TOKENS } from "../src/workers-ai-client.mjs";
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

test("Workers AI client uses bounded tool-capable model and returns text", async () => {
  let called;
  let usageSeen = null;
  const env = { DB: createBudgetDb(), AI: { run: async (...args) => { called = args; return {
    response: '{"action":"final","reply":"ok","source_ids":[]}',
    usage: { prompt_tokens: 20, completion_tokens: 5 }
  }; } } };
  const result = await callWorkersAi(env, "prompt", 500, {
    responseMimeType: "application/json",
    onUsage: async (usage) => { usageSeen = usage; }
  });
  assert.equal(result, '{"action":"final","reply":"ok","source_ids":[]}');
  assert.equal(WORKERS_AI_MODEL, "@cf/zai-org/glm-4.7-flash");
  assert.equal(called[0], WORKERS_AI_MODEL);
  assert.equal(called[1].max_completion_tokens, 500);
  assert.deepEqual(called[1].response_format, { type: "json_object" });
  assert.equal(WORKERS_AI_MAX_OUTPUT_TOKENS, 131072);
  assert.deepEqual(usageSeen, { prompt_tokens: 20, completion_tokens: 5 });
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

test("improvement plan rejects paths outside the three allowed roots", () => {
  const plan = validPlan();
  plan.operations[1].path = ".github/workflows/deploy.yml";
  assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
  plan.operations[1].path = "migrations/0014.sql";
  assert.deepEqual(validateImprovementPlan(plan), { ok: false, reason: "changed_path_out_of_scope" });
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

test("failed improvement tasks remain unchanged until edited; transient retries use the task retry schedule", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const appendStart = source.indexOf("async function appendImprovementResult");
  const inboxStart = source.indexOf("async function runImprovementInbox", appendStart);
  const recoveryStart = source.indexOf("async function recoverAgentTaskWorkflows", inboxStart);
  assert.ok(appendStart >= 0 && inboxStart > appendStart && recoveryStart > inboxStart);
  const append = source.slice(appendStart, inboxStart);
  const inbox = source.slice(inboxStart, recoveryStart);
  assert.ok(append.includes('if (result?.status === "failed") return false;'));
  assert.ok(inbox.includes('sameRequest && ["failed", "cancelled"].includes(previous?.status)'));
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
