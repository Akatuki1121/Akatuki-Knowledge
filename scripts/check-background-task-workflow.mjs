import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const taskPolicy = await readFile(new URL("../src/background-task-policy.mjs", import.meta.url), "utf8");
const toolLoop = await readFile(new URL("../src/agent-tool-loop.mjs", import.meta.url), "utf8");
const webResearch = await readFile(new URL("../src/agent-web-research.mjs", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const required of [
  "class AgentTaskWorkflow extends WorkflowEntrypoint",
  '!["knowledge_query", "github_query"].includes(task.task_type)',
  'task.task_type === "github_query"',
  "executeGitHubReadTool",
  "allowGitHubRead",
  "allowGitHubWrite",
  "github_propose_write",
  "searchAgentTaskNotes(prepared.safePrompt, this.env)",
  'step.do("retrieve-context-"',
  "if (note.ai_allowed !== 1) continue;",
  'step.do("compose-prompt-"',
  'checkpoint: { stage: "context_ready", contextNotes: notes }',
  'stage: "prompt_ready"',
  'checkpoint.stage === "completed"',
  "runAgentToolLoop",
  "searchAgentTaskNotes",
  'checkpoint.stage === "agent_loop"',
  'tool === "search_notes"',
  'tool === "get_note"',
  "inspectAndRedact(prompt",
  "inspectAndRedact(raw",
  "reserveAgentAiBudget(this.env.DB",
  "settleAgentAiBudget(this.env.DB",
  "onUsage: async (usage)",
  "onFailure: async ({ inputTokens })",
  'checkpoint.stage === "completed"',
  'taskType: "knowledge_query"',
  "assertAgentTaskRunning",
  "task_cancelled",
  "listAgentTasks",
  "allowWebResearch",
  "callWorkersAi",
  "parseGroundedWebResearch",
  'url.pathname === "/api/agent-tasks" && request.method === "GET"',
  'url.pathname === "/api/agent-tasks"',
  'request.method === "POST"',
  "await isAuthorized(request, env)",
  "inspectAndRedact(task.payload.prompt, { blocklist: this.env.PRIVACY_BLOCKLIST || \"\" })",
  "inspectAndRedact(body.prompt",
  "payload: { prompt: inspection.text, maxOutputTokens, allowWebResearch },",
  "hasSensitiveCategory(",
  "reserveAgentAiBudget",
  "step.sleepUntil",
  "AbortSignal.timeout(30_000)",
  "recordAgentTaskFailure",
  "recoverAgentTaskWorkflows",
  "reserveQueuedAgentTaskBudget",
  "requeueAgentTaskAfterBudgetWait",
  "allowRestart: true",
  'return "restart_deferred"',
  "allowRestart = false",
  'ensureAgentTaskWorkflow(env, task.task_id, { allowRestart: false })',
  "notificationStatus: task.notification_status",
  'event.cron === TASK_RECOVERY_CRON',
  'export {\n  AgentTaskWorkflow,'
]) {
  assert.ok(source.includes(required), "Missing background workflow contract: " + required);
}
assert.ok(
  source.split('task.budget_reserved === 1 && (task.status === "queued"').length - 1 >= 1,
  "HTTP intake must not dispatch before budget admission",
);
const taskMigration = await readFile(new URL("../migrations/0011_agent_tasks.sql", import.meta.url), "utf8");
assert.ok(taskMigration.includes("budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved IN (0, 1))"), "Pending task schema must include budget reservation admission flag");
assert.ok(config.includes('binding = "AGENT_TASK_WORKFLOW"'));
assert.ok(config.includes('class_name = "AgentTaskWorkflow"'));
assert.ok(config.includes('"*/15 * * * *"'));
assert.ok(config.includes('"55 23 * * *"'), "Daily system self-audit must be scheduled");
assert.ok(source.includes('event.cron === BUDGET_AUDIT_CRON'), "Daily budget and system audit must be connected to Cron");
assert.ok(source.includes('url.pathname === "/api/budget-audit"'), "Latest audit reports must be queryable through an authenticated API");
const manualAuditRouteStart = source.indexOf('url.pathname === "/api/budget-audit/run" && request.method === "POST"');
const manualAuditRouteEnd = source.indexOf('url.pathname === "/api/budget-audit" && request.method === "GET"', manualAuditRouteStart);
assert.ok(manualAuditRouteStart >= 0 && manualAuditRouteEnd > manualAuditRouteStart, "Manual budget audit must be a dedicated POST route");
const manualAuditRoute = source.slice(manualAuditRouteStart, manualAuditRouteEnd);
assert.ok(manualAuditRoute.indexOf("await isAuthorized(request, env)") < manualAuditRoute.indexOf("runBudgetSelfAudit"), "Manual budget audit must authenticate before running");
assert.ok(manualAuditRoute.includes("includeSystemAudit: true"), "Manual budget audit must include the system audit");
assert.ok(manualAuditRoute.includes('createNote(new Request("https://internal/api/notes"'), "Manual budget audit must create notes through the internal notes API");
for (const field of ["ok:", "report:", "noteCreated:", "recorded:"]) {
  assert.ok(manualAuditRoute.includes(field), "Manual budget audit response must include " + field);
}

assert.ok(source.includes('taskRow.budget_reserved !== 1'), "Workflow dispatch must wait for a reserved step budget");
assert.ok(source.includes("failure.workflowBudgetReleased === true"), "UTC day rollover must end the current Workflow run");
assert.ok(source.includes("workers_ai_daily_quota_exhausted"), "Cloudflare Workers AI quota exhaustion must wait for the UTC reset");
const workflowStart = source.indexOf("class AgentTaskWorkflow extends WorkflowEntrypoint");
const workflowEnd = source.indexOf('__name(AgentTaskWorkflow, "AgentTaskWorkflow");', workflowStart);
const workflowSource = source.slice(workflowStart, workflowEnd);
assert.ok(!workflowSource.includes("applyTelegramCapture"), "Background knowledge query must not mutate notes");
assert.ok(!workflowSource.includes("INSERT INTO telegram_notes"), "Background knowledge query must remain read-only");
assert.ok(workflowSource.includes("saveAgentTaskCheckpoint"), "Each agent loop stage must be persisted in the task checkpoint");
assert.ok(workflowSource.includes("step.do(\n            \"agent-model-\""), "Every model call must be a durable Workflow step");
const modelCallStart = workflowSource.indexOf("callModel: async ({ prompt, modelCall })");
const modelCallEnd = workflowSource.indexOf("executeTool: async", modelCallStart);
assert.ok(modelCallStart >= 0 && modelCallEnd > modelCallStart, "Agent model call implementation must exist");
assert.ok(workflowSource.slice(modelCallStart, modelCallEnd).includes('responseMimeType: "application/json"'), "Agent tool-loop calls must request JSON output");
assert.ok(workflowSource.includes("step.do(\n            \"agent-tool-\""), "Every read-only tool execution must be a durable Workflow step");
assert.ok(workflowSource.includes('if (tool === "get_note")'), "The note detail tool must be restricted to prior search results");
assert.ok(!toolLoop.includes("maxModelCalls") && !toolLoop.includes("maxToolCalls"), "Agent model/tool turns must not have application-specific count caps");
assert.ok(toolLoop.includes('search_notes: Object.freeze') && toolLoop.includes('get_note: Object.freeze'), "Only the explicit read-only tool allowlist may be exposed");
assert.ok(toolLoop.includes('sideEffect: "external_read"'), "Web research must be distinguished from local read-only tools");
assert.ok(toolLoop.includes("state.toolCalls.filter((call) => call.tool === \"web_research\")"), "Web research calls must have their own bounded budget");
assert.ok(toolLoop.includes("allowWebResearch === true"), "Web research must require explicit per-task permission");
assert.ok(webResearch.includes('step?.type === "google_search_call"'), "Web results must have a Google Search grounding step");
assert.ok(webResearch.includes('step?.type === "url_context_result"'), "Web results must have inspected page retrieval");
assert.ok(webResearch.includes('annotation?.type !== "url_citation"'), "Only provider citations may become web sources");
assert.ok(source.includes('throw new Error("web_research_disabled")'), "Web research must remain disabled");
assert.ok(source.includes('body.allowWebResearch !== undefined && body.allowWebResearch !== false'), "API must reject web research requests");
assert.ok(config.includes('binding = "AI"'), "Workers AI binding must be configured");
assert.ok(source.includes("runImprovementInbox(env)"), "Hourly pull must be followed by improvement inbox scanning");
assert.ok(source.includes("executeApprovedImprovementPlan"), "Improvement plan execution must use the constrained executor");
assert.ok(source.includes("appendImprovementResult"), "Improvement task outcomes must be written back to their source note");
assert.ok(!source.includes("IMPROVEMENT_AUTOMATION_LIMITS.maxTasksPerDay"), "Improvement tasks must use shared resource budgets, not a separate daily task cap");
assert.ok(toolLoop.includes('throw new Error("unknown_tool")'), "Unknown tools must fail closed");
assert.ok(toolLoop.includes('throw new Error("tool_loop_detected")'), "Repeated tool calls must stop");
assert.ok(toolLoop.includes("AGENT_TOOL_LIMITS.maxToolOutputChars"), "Tool output size must be bounded");
assert.ok(toolLoop.includes("allowedIds.has(id)"), "Final citations must be limited to retrieved notes");
const prepareStart = workflowSource.indexOf('step.do("prepare-"');
const retrieveStart = workflowSource.indexOf('step.do("retrieve-context-"', prepareStart);
const prepareSource = workflowSource.slice(prepareStart, retrieveStart);
assert.ok(prepareSource.includes('checkpoint.stage === "completed"'), "Completed checkpoints must be recognized before context retrieval");
assert.ok(prepareSource.includes("resumeCompleted: true"), "A completed checkpoint must resume without regenerating the answer");
assert.ok(prepareSource.includes('checkpoint.stage === "prompt_ready"'), "Prompt checkpoints must be recognized before context retrieval");
assert.ok(prepareSource.includes("resumePrompt: checkpoint.prompt"), "Prompt checkpoints must reuse the exact saved prompt");
assert.ok(prepareSource.includes("contextNotes: Array.isArray(checkpoint.contextNotes)"), "Prompt checkpoints must carry forward their saved context");
assert.ok(prepareSource.includes('checkpoint.stage === "context_ready"'), "Context checkpoints must be recognized before note search");
const retrieveEnd = workflowSource.indexOf('step.do("compose-prompt-"', retrieveStart);
const retrieveSource = workflowSource.slice(retrieveStart, retrieveEnd);
assert.ok(retrieveSource.includes("if (prepared.contextNotes) return { notes: prepared.contextNotes };"), "Context checkpoints must bypass a repeated note search");
const composeStart = retrieveEnd;
const composeEnd = workflowSource.indexOf("runAgentToolLoop({", composeStart);
const composeSource = workflowSource.slice(composeStart, composeEnd);
assert.ok(composeSource.includes("if (prepared.resumePrompt)"), "Saved prompts must bypass prompt recomposition after recovery");
const stopGuidanceStart = taskPolicy.indexOf("function describeAgentTaskStopReason");
const stopGuidanceEnd = taskPolicy.indexOf('__name(describeAgentTaskStopReason', stopGuidanceStart);
assert.ok(stopGuidanceStart >= 0 && stopGuidanceEnd > stopGuidanceStart, "Task stop-reason guidance must exist");
const stopGuidance = taskPolicy.slice(stopGuidanceStart, stopGuidanceEnd);
for (const required of [
  'task_deadline_exceeded: ["処理時間の上限に到達"',
  'attempt_budget_exhausted: ["再試行回数の上限に到達"',
  'credentials_detected: ["認証情報を検出"',
  'pii_masking_failed: ["個人情報を安全にマスキングできない"',
  'nextAction: "依頼内容を確認し、対象を絞って新しい /task として依頼してください。"'
]) {
  assert.ok(stopGuidance.includes(required), "Missing actionable stop-reason guidance: " + required);
}
const githubPromptStart = source.indexOf("あなたは日本語のGitHub作業エージェントです。");
const githubPromptEnd = source.indexOf("\n              : prepared.allowGitHubRead", githubPromptStart);
const githubPrompt = source.slice(githubPromptStart, githubPromptEnd);
assert.ok(githubPrompt.includes("依頼文と会話文脈から一意に特定できない場合は、推測で補完せず"), "GitHub tasks must ask when the repository or required Issue/PR target is ambiguous");
assert.ok(githubPrompt.includes("GitHubツールを呼び出したり変更計画を作ったりする前に不足情報を短く質問"), "Ambiguous GitHub tasks must ask before tool execution or write planning");

const improvementPromptStart = source.indexOf("あなたは日本語の改善依頼エージェントです。");
const improvementPromptEnd = source.indexOf("\n              : prepared.allowGitHubRead", improvementPromptStart);
const improvementPrompt = source.slice(improvementPromptStart, improvementPromptEnd);
for (const required of [
  "tests/",
  "schema-snapshots/",
  "migrations/pending/",
  "wrangler.toml",
  "package-lock.json",
  "read-only permissions",
  "auto-merge.yml",
  "check.yml",
  "deploy.yml",
  "github_read_file",
  "apply_patch",
  "500000"
]) {
  assert.ok(improvementPrompt.includes(required), "Improvement agent prompt must disclose the expanded implementation scope: " + required);
}
assert.ok(!improvementPrompt.includes("変更対象は src/、scripts/、docs/ のみ"), "Improvement agent prompt must not retain the old reduced scope");

// Every AgentTaskWorkflow step uses the explicitly approved one-retry policy.
const retryConfigs = [...source.matchAll(/retries:\s*\{\s*limit:\s*1\s*,\s*delay:\s*"1 second"\s*\}/g)].map((match) => match[0]);
// Telegram 通知ステップ5件の廃止で 17 から 12 に減った。PR #169 で改善計画の実行と結果書き戻しの2ステップが加わり、14になった。
assert.equal(retryConfigs.length, 14, "Every AgentTaskWorkflow step must use one retry with a one-second delay");
assert.ok(!/retries:\s*\{\s*limit:\s*0\b/.test(source), "AgentTaskWorkflow must not retain the rejected zero-retry config");




const deployOnMerge = await readFile(new URL("../.github/workflows/deploy-on-merge.yml", import.meta.url), "utf8");
assert.ok(deployOnMerge.includes("pull_request:"), "Deploy dispatch must be triggered by pull_request events");
assert.ok(deployOnMerge.includes("types: [closed]"), "Deploy dispatch must run after a PR is closed");
assert.ok(deployOnMerge.includes("- main"), "Deploy dispatch must be limited to PRs targeting main");
assert.ok(deployOnMerge.includes("if: github.event.pull_request.merged == true"), "Only merged pull requests may dispatch Deploy");
assert.ok(deployOnMerge.includes("permissions:\n  actions: write"), "Deploy dispatch must use only actions: write permission");
assert.ok(deployOnMerge.includes("gh run list --workflow deploy.yml --branch main"), "Deploy dispatch must inspect recent Deploy workflow runs");
assert.ok(deployOnMerge.includes("github.event.pull_request.merge_commit_sha"), "Duplicate detection must use the PR merge commit SHA");
assert.ok(deployOnMerge.includes('grep -Fxq "$MERGE_SHA"'), "An existing run for the merge commit must suppress dispatch");
assert.ok(deployOnMerge.includes("gh workflow run deploy.yml --ref main"), "A missing run must dispatch Deploy against main");

console.log("Background knowledge-query Workflow, checkpoint, authorization, safety, recovery, retry, and deploy-dispatch contracts passed.");