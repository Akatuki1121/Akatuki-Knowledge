// ボットアラート (運用通知) (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。アラートの状態は D1 テーブル bot_alerts に
// 外部化されており、このモジュールはモジュール内状態を持たない。
// describeSafeFailure は src/log-sanitize.mjs から直接 import し (organize.mjs の前例)、
// Telegram 送信関数は呼び出し側から注入する。Worker エントリポイントには依存しない。
import { describeSafeFailure } from "./log-sanitize.mjs";

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// ボットアラートの関数群を組み立てる。本文は移動前と同一。
export function createBotAlerts({ sendTelegramMessage }) {
function alertWindowKey(category, now = /* @__PURE__ */ new Date()) {
  return `${category}:${now.toISOString().slice(0, 10)}`;
}
__name(alertWindowKey, "alertWindowKey");
async function enqueueBotAlert(env, category) {
  if (!env.DB) return;
  const safeCategory = ["gemini_limit", "configuration", "processing_failure"].includes(category) ? category : "processing_failure";
  const now = (/* @__PURE__ */ new Date()).toISOString();
  try {
    await env.DB.prepare(`INSERT INTO bot_alerts (alert_key, category, first_seen_at, last_seen_at, occurrences, status, next_attempt_at, send_attempts)
      VALUES (?, ?, ?, ?, 1, 'pending', ?, 0)
      ON CONFLICT(alert_key) DO UPDATE SET last_seen_at = excluded.last_seen_at, occurrences = bot_alerts.occurrences + 1`).bind(alertWindowKey(safeCategory, new Date(now)), safeCategory, now, now, now).run();
  } catch (error) {
    console.error("could not persist operational alert", JSON.stringify(describeSafeFailure("operational_alert_persist_failed", error)));
  }
}
__name(enqueueBotAlert, "enqueueBotAlert");
function alertText(alert) {
  const messages = {
    gemini_limit: "Gemini\u306E\u5229\u7528\u4E0A\u9650\u307E\u305F\u306F\u30EC\u30FC\u30C8\u5236\u9650\u3067AI\u51E6\u7406\u304C\u6B62\u307E\u3063\u305F\u3088\u3002\u4FDD\u5B58\u6E08\u307F\u306E\u30CE\u30FC\u30C8\u306FD1\u306B\u6B8B\u3057\u3001\u518D\u8A66\u884C\u3092\u7D9A\u3051\u308B\u306D\u3002",
    configuration: "AI\u51E6\u7406\u306B\u5FC5\u8981\u306A\u8A2D\u5B9A\u304C\u898B\u3064\u304B\u3089\u305A\u3001\u81EA\u52D5\u6574\u7406\u304C\u6B62\u307E\u3063\u3066\u3044\u308B\u3088\u3002\u8A2D\u5B9A\u304C\u623B\u308C\u3070\u518D\u8A66\u884C\u3059\u308B\u306D\u3002",
    processing_failure: "\u81EA\u52D5\u6574\u7406\u306B\u5931\u6557\u3057\u305F\u3088\u3002\u30CE\u30FC\u30C8\u306FD1\u306B\u6B8B\u3057\u3066\u3001\u6B21\u306E\u518D\u8A66\u884C\u306B\u56DE\u3057\u305F\u3088\u3002\u539F\u56E0\u306F\u307E\u3060\u7279\u5B9A\u3067\u304D\u3066\u3044\u306A\u3044\u3088\u3002"
  };
  return `${messages[alert.category] || messages.processing_failure}${Number(alert.occurrences) > 1 ? `\uFF08\u540C\u7A2E\u306E\u4E8B\u8C61 ${alert.occurrences} \u4EF6\u3092\u307E\u3068\u3081\u3066\u901A\u77E5\uFF09` : ""}`;
}
__name(alertText, "alertText");
async function flushBotAlerts(env, chatId, limit = 3) {
  if (!env.DB || !chatId || !env.TELEGRAM_BOT_TOKEN) return;
  let alerts;
  try {
    const result = await env.DB.prepare("SELECT alert_key, category, occurrences, send_attempts FROM bot_alerts WHERE ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND claim_expires_at <= ?)) ORDER BY first_seen_at ASC LIMIT ?").bind((/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString(), Math.max(1, Math.min(5, limit))).all();
    alerts = result.results || [];
  } catch (error) {
    console.error("could not read operational alerts", JSON.stringify(describeSafeFailure("operational_alert_read_failed", error)));
    return;
  }
  for (const alert of alerts) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const claimed = await env.DB.prepare("UPDATE bot_alerts SET status = 'sending', claim_expires_at = ? WHERE alert_key = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND claim_expires_at <= ?))").bind(new Date(Date.now() + 2 * 6e4).toISOString(), alert.alert_key, now, now).run();
    if (!claimed.meta?.changes) continue;
    try {
      await sendTelegramMessage(env, chatId, alertText(alert));
      await env.DB.prepare("UPDATE bot_alerts SET status = 'sent', sent_at = ?, claim_expires_at = NULL, send_attempts = send_attempts + 1 WHERE alert_key = ? AND status = 'sending'").bind((/* @__PURE__ */ new Date()).toISOString(), alert.alert_key).run();
    } catch {
      const attempts = Math.min(10, Number(alert.send_attempts || 0) + 1);
      const retryAt = new Date(Date.now() + Math.min(24 * 60, 5 * 2 ** (attempts - 1)) * 6e4).toISOString();
      try {
        await env.DB.prepare("UPDATE bot_alerts SET status = 'pending', claim_expires_at = NULL, send_attempts = ?, next_attempt_at = ? WHERE alert_key = ? AND status = 'sending'").bind(attempts, retryAt, alert.alert_key).run();
      } catch (error) {
        console.error("could not reschedule operational alert", JSON.stringify(describeSafeFailure("operational_alert_reschedule_failed", error)));
      }
    }
  }
}
__name(flushBotAlerts, "flushBotAlerts");
  return { alertWindowKey, enqueueBotAlert, alertText, flushBotAlerts };
}
