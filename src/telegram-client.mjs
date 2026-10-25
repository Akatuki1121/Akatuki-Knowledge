// Telegram 送信クライアント (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。依存は env.TELEGRAM_BOT_TOKEN と、呼び出し時点の
// グローバル fetch のみで、このモジュールは Worker エントリポイントに依存しない。
// ファクトリ形式は src/reply-text.mjs に揃えたが、注入する依存はない。

// Telegram 送信・編集の関数群を組み立てる。本文は移動前と同一。
export function createTelegramClient() {
async function sendTelegramMessage(env, chatId, text2) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text2 })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw new Error(`Telegram sendMessage returned ${response.status}`);
  return data?.result?.message_id ?? null;
}
async function editTelegramMessage(env, chatId, messageId, text2) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text2.slice(0, 3500) })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw new Error(`Telegram editMessageText returned ${response.status}`);
}
  return { sendTelegramMessage, editTelegramMessage };
}
