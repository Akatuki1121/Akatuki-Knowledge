import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const webhookStart = source.indexOf("async function handleTelegramUpdate");
const webhookEnd = source.indexOf("__name(handleTelegramUpdate", webhookStart);
const webhook = webhookStart >= 0 && webhookEnd > webhookStart
  ? source.slice(webhookStart, webhookEnd)
  : source.slice(source.indexOf('INSERT INTO telegram_updates'), source.indexOf('async function startTelegramBackgroundTask'));

assert.ok(source.includes("telegram_updates (update_id, received_at, result_code)"), "Webhook updates must be persisted by update_id");
assert.ok(source.includes("state?.result_code === \"retry\""), "Failed webhook updates must be eligible for retry");
assert.ok(source.includes("state?.result_code === \"processing\" && state.received_at < staleBefore"), "Only stale processing updates may be reclaimed");
assert.ok(source.includes("WHERE update_id = ? AND result_code = ? AND received_at = ?"), "Webhook reclaim must use compare-and-set to avoid concurrent duplicate processing");
assert.ok(source.includes('"telegram:" + chatId + ":" + messageId'), "Task idempotency key must bind Telegram chat and message IDs");

const notificationStart = source.indexOf("async function flushAgentTaskNotifications");
const notificationEnd = source.indexOf("__name(flushAgentTaskNotifications", notificationStart);
assert.ok(notificationStart >= 0 && notificationEnd > notificationStart, "Terminal notification dispatcher must exist");
const notification = source.slice(notificationStart, notificationEnd);

for (const required of [
  "status IN ('succeeded', 'failed', 'cancelled')",
  "notification_status = 'pending'",
  "notification_status = 'sending'",
  "notification_lease_expires_at <= ?",
  "SET notification_status = 'sending'",
  "WHERE task_id = ? AND notification_status = 'sending' AND notification_lease_expires_at = ?",
  "const exhausted = attempts >= 8",
  "const delayMinutes = Math.min(24 * 60, 5 * (2 ** Math.min(attempts - 1, 8)))",
  "notification_last_error_class = 'telegram_delivery_failed'",
  "checkpoint.result.slice(0, 2500)",
  "notification_status = 'sent'",
]) {
  assert.ok(notification.includes(required), "Missing notification safety contract: " + required);
}

assert.ok(
  notification.indexOf("await sendTelegramMessage(env, task.notify_chat_id, message)") <
    notification.indexOf("SET notification_status = 'sent'"),
  "Delivery must be attempted before the task is marked notified",
);
assert.ok(
  notification.includes("notification_status = ?, notification_lease_expires_at = NULL"),
  "Failed delivery must release its lease and either retry or stop",
);
assert.ok(
  notification.includes('exhausted ? "failed" : "pending"'),
  "Notification retries must stop after the configured attempt cap",
);
assert.ok(
  !notification.includes("status IN ('queued', 'running', 'waiting')"),
  "Non-terminal tasks must not receive terminal-result notifications",
);

console.log("Telegram update deduplication and background-task notification retry contracts passed.");
