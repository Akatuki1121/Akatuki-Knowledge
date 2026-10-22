import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const toolLoop = await readFile(new URL("../src/agent-tool-loop.mjs", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const required of [
  "class AgentTaskWorkflow extends WorkflowEntrypoint",
  'task.task_type !== "knowledge_query"',
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
  "listTelegramBackgroundTasks",
  "listAgentTasks",
  '/tasks(?:@\\w+)?',
  'url.pathname === "/api/agent-tasks" && request.method === "GET"',
  "const stageLabels = {",
  'context_ready: "関連ノートの取得完了"',
  'prompt_ready: "要約プロンプトの準備完了"',
  'completed: "結果の保存完了"',
  '"\\n段階: " + (stageLabels[stage] || stage)',
  "/task_status",
  'url.pathname === "/api/agent-tasks"',
  'request.method === "POST"',
  "await isAuthorized(request, env)",
  "inspectAndRedact(task.payload.prompt, { blocklist: this.env.PRIVACY_BLOCKLIST || \"\" })",
  "inspectAndRedact(body.prompt",
  "payload: { prompt: inspection.text, maxOutputTokens },",
  '["health", "financial", "location"]',
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
assert.ok(workflowSource.includes("step.do(\n            \"agent-tool-\""), "Every read-only tool execution must be a durable Workflow step");
assert.ok(workflowSource.includes('if (tool === "get_note")'), "The note detail tool must be restricted to prior search results");
assert.ok(toolLoop.includes("maxModelCalls: 5") && toolLoop.includes("maxToolCalls: 4"), "Agent loop budgets must remain bounded");
assert.ok(toolLoop.includes('search_notes: Object.freeze') && toolLoop.includes('get_note: Object.freeze'), "Only the explicit read-only tool allowlist may be exposed");
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
console.log("Background knowledge-query Workflow, checkpoint, authorization, safety, recovery, and retry contracts passed.");
