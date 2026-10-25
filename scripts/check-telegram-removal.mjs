import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// Telegram ボット廃止の契約: 入口 (Webhook) と送信経路が戻らないこと、
// 残す面 ( /api と /sync と DO の同期) が壊れていないことを固定する。
// telegram_notes テーブルや過去データの読み書き ( /api 、DO のファイル化) は
// 廃止対象ではないため、ここでは禁止しない。
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const botAlertsSource = await readFile(new URL("../src/bot-alerts.mjs", import.meta.url), "utf8");

for (const removed of [
  "/telegram/webhook",
  "telegramWebhook",
  "sendTelegramMessage",
  "editTelegramMessage",
  "api.telegram.org",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_CHAT_ID",
  "/api/telegram/history",
  "listTelegramHistory",
  "answerTelegramMessage",
  "enqueueAgentMemoryJob",
  "drainAgentMemoryQueue",
  "flushBotAlerts",
  "flushAgentTaskNotifications"
]) {
  assert.ok(!source.includes(removed), `Telegram entry/delivery must stay removed: ${removed}`);
}

for (const removedModule of [
  "src/telegram-client.mjs",
  "src/telegram-intent.mjs",
  "src/ai-permission.mjs",
  "src/intent-classifier.mjs",
  "src/agent-memory-queue.mjs",
  "src/agent-memory-drain.mjs"
]) {
  assert.ok(!existsSync(new URL(`../${removedModule}`, import.meta.url)), `Removed module must not reappear: ${removedModule}`);
}

for (const kept of [
  'url.pathname === "/api/notes"',
  'url.pathname === "/api/sync"',
  'url.pathname === "/api/search"',
  'url.pathname === "/api/ask"',
  'url.pathname === "/api/organize"',
  'url.pathname === "/sync/status"',
  "pullFromVault",
  "drainSyncOutbox(env, 10)",
  "backfillSyncUuidIndex(env, 100)",
  "class AgentTaskWorkflow extends WorkflowEntrypoint",
  "recoverAgentTaskWorkflows",
  "createTelegramNotes",
  "renameTelegramFiles"
]) {
  assert.ok(source.includes(kept), `Kept surface must remain wired: ${kept}`);
}

assert.ok(!botAlertsSource.includes("sendTelegramMessage"), "Bot alerts must not send to Telegram");
assert.ok(!botAlertsSource.includes("INSERT INTO bot_alerts"), "Bot alerts must not persist to bot_alerts");
assert.ok(botAlertsSource.includes("operational_alert"), "Bot alerts must remain visible as structured logs");

console.log("Telegram removal contract checks passed.");
