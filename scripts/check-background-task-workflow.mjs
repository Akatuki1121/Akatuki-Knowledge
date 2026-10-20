import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const required of [
  "class AgentTaskWorkflow extends WorkflowEntrypoint",
  'task.task_type !== "knowledge_query"',
  "findRelevantNotes(prepared.safePrompt, this.env, 8)",
  'step.do("retrieve-context-"',
  'step.do("compose-prompt-"',
  'checkpoint: { stage: "context_ready", contextNotes: notes }',
  'stage: "prompt_ready"',
  'checkpoint.stage === "completed"',
  "parseJsonObject(safeResponse.text)",
  'taskType: "knowledge_query"',
  "startTelegramBackgroundTask",
  "getTelegramBackgroundTaskStatus",
  "const stageLabels = {",
  'context_ready: "関連ノートの取得完了"',
  'prompt_ready: "要約プロンプトの準備完了"',
  'completed: "結果の保存完了"',
  '"\n段階: " + (stageLabels[stage] || stage)',
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
assert.ok(config.includes('binding = "AGENT_TASK_WORKFLOW"'));
assert.ok(config.includes('class_name = "AgentTaskWorkflow"'));
assert.ok(config.includes('"*/15 * * * *"'));
const workflowStart = source.indexOf("class AgentTaskWorkflow extends WorkflowEntrypoint");
const workflowEnd = source.indexOf('__name(AgentTaskWorkflow, "AgentTaskWorkflow");', workflowStart);
const workflowSource = source.slice(workflowStart, workflowEnd);
assert.ok(!workflowSource.includes("applyTelegramCapture"), "Background knowledge query must not mutate notes");
assert.ok(!workflowSource.includes("INSERT INTO telegram_notes"), "Background knowledge query must remain read-only");
console.log("Background knowledge-query Workflow, checkpoint, authorization, safety, recovery, and retry contracts passed.");
