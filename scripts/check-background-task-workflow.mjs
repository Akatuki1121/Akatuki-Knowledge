import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const telegramBackgroundTasks = await readFile(new URL("../src/telegram-background-tasks.mjs", import.meta.url), "utf8");
const geminiClient = await readFile(new URL("../src/gemini-client.mjs", import.meta.url), "utf8");
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
  "isGitHubNaturalLanguageRequest",
  "approveGitHubWritePlan",
  "rejectGitHubWritePlan",
  "executeGitHubWritePlan",
  '{ taskType: "github_query", allowGitHubRead: true, allowGitHubWrite: true }',
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
  'checkpoint.stage === "completed"',
  'taskType: "knowledge_query"',
  "startTelegramBackgroundTask",
  "getTelegramBackgroundTaskStatus",
  "cancelTelegramBackgroundTask",
  "cancelAgentTask",
  "/cancel タスクID",
  "assertAgentTaskRunning",
  "task_cancelled",
  "listTelegramBackgroundTasks",
  "listAgentTasks",
  "const stageLabels = {",
  "allowWebResearch",
  "GEMINI_WEB_RESEARCH_ENABLED",
  "callGeminiWebResearch",
  "parseGroundedWebResearch",
  '/tasks(?:@\\w+)?',
  'url.pathname === "/api/agent-tasks" && request.method === "GET"',
  "/task_status",
  'url.pathname === "/api/agent-tasks"',
  'request.method === "POST"',
  "await isAuthorized(request, env)",
  "inspectAndRedact(task.payload.prompt, { blocklist: this.env.PRIVACY_BLOCKLIST || \"\" })",
  "inspectAndRedact(body.prompt",
  "payload: { prompt: inspection.text, maxOutputTokens: 512, allowWebResearch, allowGitHubRead, allowGitHubWrite },",
  "payload: { prompt: inspection.text, maxOutputTokens, allowWebResearch },",
  "hasSensitiveCategory(",
  "reserveAgentAiBudget",
  "step.sleepUntil",
  "AbortSignal.timeout(30_000)",
  "recordAgentTaskFailure",
  "recoverAgentTaskWorkflows",
  "allowRestart: true",
  'return "restart_deferred"',
  "allowRestart = false",
  'ensureAgentTaskWorkflow(env, task.task_id, { allowRestart: false })',
  "flushAgentTaskNotifications",
  "notificationStatus: task.notification_status",
  "notification_status = 'sending'",
  "notification_last_error_class = 'telegram_delivery_failed'",
  "notifyChatId: chatId",
  'event.cron === TASK_RECOVERY_CRON',
  'export {\n  AgentTaskWorkflow,'
]) {
  assert.ok(source.includes(required), "Missing background workflow contract: " + required);
}
// Issue #86: 状態確認・取消・一覧の Telegram ハンドラは src/telegram-background-tasks.mjs へ
// 分離したため、ハンドラ本体にしか現れない文字列はモジュール側で検証する。
for (const required of [
  "instance.terminate()",
  'context_ready: "関連ノートの取得完了"',
  'prompt_ready: "要約プロンプトの準備完了"',
  'completed: "結果の保存完了"',
  '"\\n段階: " + (stageLabels[stage] || stage)'
]) {
  assert.ok(telegramBackgroundTasks.includes(required), "Missing Telegram background task handler contract: " + required);
}
assert.ok(
  source.split('task.budget_reserved === 1 && (task.status === "queued"').length - 1 >= 2,
  "Telegram and HTTP intake must not dispatch before budget admission",
);
const terminalNotificationStart = source.indexOf('let message = "背景タスク " + statusText');
const terminalNotificationEnd = source.indexOf('await sendTelegramMessage(env, task.notify_chat_id, message);', terminalNotificationStart);
assert.ok(terminalNotificationStart >= 0 && terminalNotificationEnd > terminalNotificationStart, "Terminal notification message must exist");
assert.ok(!source.slice(terminalNotificationStart, terminalNotificationEnd).includes("\\\\n"), "Terminal notification must use actual newline escapes, not literal backslash-n text");
const taskMigration = await readFile(new URL("../migrations/0011_agent_tasks.sql", import.meta.url), "utf8");
assert.ok(taskMigration.includes("budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved IN (0, 1))"), "Pending task schema must include budget reservation admission flag");
assert.ok(config.includes('binding = "AGENT_TASK_WORKFLOW"'));
assert.ok(config.includes('class_name = "AgentTaskWorkflow"'));
assert.ok(config.includes('"*/15 * * * *"'));
const workflowStart = source.indexOf("class AgentTaskWorkflow extends WorkflowEntrypoint");
const workflowEnd = source.indexOf('__name(AgentTaskWorkflow, "AgentTaskWorkflow");', workflowStart);
const workflowSource = source.slice(workflowStart, workflowEnd);
assert.ok(!workflowSource.includes("applyTelegramCapture"), "Background knowledge query must not mutate notes");
assert.ok(!workflowSource.includes("INSERT INTO telegram_notes"), "Background knowledge query must remain read-only");
assert.ok(workflowSource.includes("saveAgentTaskCheckpoint"), "Each agent loop stage must be persisted in the task checkpoint");
assert.ok(workflowSource.includes("step.do(\n            \"agent-model-\""), "Every model call must be a durable Workflow step");
const geminiStart = geminiClient.indexOf("async function callGemini(");
const geminiEnd = geminiClient.indexOf('__name(callGemini, "callGemini");', geminiStart);
const geminiSource = geminiClient.slice(geminiStart, geminiEnd);
assert.ok(geminiSource.includes("options.responseMimeType"), "Gemini calls must support an explicit response MIME type");
const modelCallStart = workflowSource.indexOf("callModel: async ({ prompt, modelCall })");
const modelCallEnd = workflowSource.indexOf("executeTool: async", modelCallStart);
assert.ok(modelCallStart >= 0 && modelCallEnd > modelCallStart, "Agent model call implementation must exist");
assert.ok(workflowSource.slice(modelCallStart, modelCallEnd).includes('responseMimeType: "application/json"'), "Agent tool-loop calls must request JSON output from Gemini");
assert.ok(workflowSource.includes("step.do(\n            \"agent-tool-\""), "Every read-only tool execution must be a durable Workflow step");
assert.ok(workflowSource.includes('if (tool === "get_note")'), "The note detail tool must be restricted to prior search results");
assert.ok(toolLoop.includes("maxModelCalls: 5") && toolLoop.includes("maxToolCalls: 4"), "Agent loop budgets must remain bounded");
assert.ok(toolLoop.includes('search_notes: Object.freeze') && toolLoop.includes('get_note: Object.freeze'), "Only the explicit read-only tool allowlist may be exposed");
assert.ok(toolLoop.includes('sideEffect: "external_read"'), "Web research must be distinguished from local read-only tools");
assert.ok(toolLoop.includes("state.toolCalls.filter((call) => call.tool === \"web_research\")"), "Web research calls must have their own bounded budget");
assert.ok(toolLoop.includes("allowWebResearch === true"), "Web research must require explicit per-task permission");
assert.ok(webResearch.includes('step?.type === "google_search_call"'), "Web results must have a Google Search grounding step");
assert.ok(webResearch.includes('step?.type === "url_context_result"'), "Web results must have inspected page retrieval");
assert.ok(webResearch.includes('annotation?.type !== "url_citation"'), "Only provider citations may become web sources");
assert.ok(geminiClient.includes('store: false'), "Web research interactions must not be stored by the provider");
assert.ok(geminiClient.includes('tools: [{ type: "google_search" }, { type: "url_context" }]'), "Web research must use grounded search and page context");
assert.ok(source.includes('signal: AbortSignal.timeout(90_000)'), "Web research requests must be bounded by a timeout");
assert.ok(source.includes('if (allowWebResearch && env.GEMINI_WEB_RESEARCH_ENABLED !== "true")'), "User opt-in alone must not enable web research while the Worker gate is off");
assert.ok(!config.includes("GEMINI_WEB_RESEARCH_ENABLED"), "The default Wrangler config must keep potentially billable web research disabled");
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
const taskListStart = telegramBackgroundTasks.indexOf("async function listTelegramBackgroundTasks");
const taskListEnd = telegramBackgroundTasks.indexOf('__name(listTelegramBackgroundTasks', taskListStart);
assert.ok(taskListStart >= 0 && taskListEnd > taskListStart, "Telegram task-list formatter must exist");
const taskListSource = telegramBackgroundTasks.slice(taskListStart, taskListEnd);
for (const label of [
  'pending: "通知待ち"',
  'sending: "通知中"',
  'sent: "通知済み"',
  'failed: "通知停止"',
  'notificationLabels[task.notification_status]'
]) {
  assert.ok(taskListSource.includes(label), "Telegram task list must localize notification state: " + label);
}

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
const taskStatusStart = telegramBackgroundTasks.indexOf("async function getTelegramBackgroundTaskStatus");
const taskStatusEnd = telegramBackgroundTasks.indexOf('__name(getTelegramBackgroundTaskStatus', taskStatusStart);
const taskStatusSource = telegramBackgroundTasks.slice(taskStatusStart, taskStatusEnd);
assert.ok(taskStatusSource.includes('describeAgentTaskStopReason(task.stop_reason)'), "Task status must explain failures");
assert.ok(taskStatusSource.includes('"\\n次の操作: " + guidance.nextAction'), "Task status must include a next action");
const notificationDispatchStart = source.indexOf("async function flushAgentTaskNotifications");
const notificationDispatchEnd = source.indexOf('__name(flushAgentTaskNotifications', notificationDispatchStart);
const notificationDispatchSource = source.slice(notificationDispatchStart, notificationDispatchEnd);
assert.ok(notificationDispatchSource.includes('describeAgentTaskStopReason(task.stop_reason)'), "Failure notifications must explain the stop reason");
assert.ok(notificationDispatchSource.includes('"\\n次の操作: " + guidance.nextAction'), "Failure notifications must include a next action");

const githubPromptStart = source.indexOf("あなたは日本語のGitHub作業エージェントです。");
const githubPromptEnd = source.indexOf("\n              : prepared.allowGitHubRead", githubPromptStart);
const githubPrompt = source.slice(githubPromptStart, githubPromptEnd);
assert.ok(githubPrompt.includes("依頼文と会話文脈から一意に特定できない場合は、推測で補完せず"), "GitHub tasks must ask when the repository or required Issue/PR target is ambiguous");
assert.ok(githubPrompt.includes("GitHubツールを呼び出したり変更計画を作ったりする前に不足情報を短く質問"), "Ambiguous GitHub tasks must ask before tool execution or write planning");

// Every AgentTaskWorkflow step uses the explicitly approved one-retry policy.
const retryConfigs = [...source.matchAll(/retries:\s*\{\s*limit:\s*1\s*,\s*delay:\s*"1 second"\s*\}/g)].map((match) => match[0]);
assert.equal(retryConfigs.length, 17, "Every AgentTaskWorkflow step must use one retry with a one-second delay");
assert.ok(!/retries:\s*\{\s*limit:\s*0\b/.test(source), "AgentTaskWorkflow must not retain the rejected zero-retry config");

console.log("Background knowledge-query Workflow, checkpoint, authorization, safety, recovery, and retry contracts passed.");
