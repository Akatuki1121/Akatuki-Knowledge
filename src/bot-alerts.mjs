// 運用アラート (Issue #86 で src/index.js から分離)。
// Telegram ボットの廃止に伴い、アラートの配送は行わない。enqueueBotAlert は
// カテゴリを検証したうえで Workers Logs へ構造化ログを出すだけになり、
// bot_alerts テーブルへの書き込みと Telegram 送信への配送は廃止した。
// 過去に bot_alerts へ書かれたデータはそのまま残る (データは消さない)。
// ログにはカテゴリと日次の集約キーだけを含め、本文や自由文字列は出さない。
// Worker エントリポイントには依存しない。

// src/index.js のバンドル由来のヘルパー。関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// 運用アラートの関数群を組み立てる。引数 (送信関数の注入) は不要になった。
export function createBotAlerts() {
function alertWindowKey(category, now = /* @__PURE__ */ new Date()) {
  return `${category}:${now.toISOString().slice(0, 10)}`;
}
__name(alertWindowKey, "alertWindowKey");
async function enqueueBotAlert(env, category) {
  const safeCategory = ["gemini_limit", "configuration", "processing_failure"].includes(category) ? category : "processing_failure";
  console.error("operational alert", JSON.stringify({ event: "operational_alert", alertKey: alertWindowKey(safeCategory), category: safeCategory }));
}
__name(enqueueBotAlert, "enqueueBotAlert");
  return { alertWindowKey, enqueueBotAlert };
}
