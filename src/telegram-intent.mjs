// Telegram 意図判定の純粋述語群 (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。全て正規表現・文字列処理のみで、env・D1・
// 他モジュールへの依存はない。ユーザ発話の振り分け (会話要約・再整理・
// 巻き戻し・改善案・フォルダ整理・記憶候補) の判定だけを行い、AI 送信境界や
// 安全ゲート (isRestrictedImprovement は index.js 側に残す) には触れない。
// Worker エントリポイントには依存しない。

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// Telegram 意図判定の述語群を組み立てる。本文は移動前と同一。
export function createTelegramIntent() {
function isConversationSummaryRequest(message) {
  return /(?:ここまで|今まで|これまで|この会話|この話).{0,24}(?:知識|会話|話|内容).{0,12}(?:まとめ|要約)|(?:知識|会話|話|内容).{0,12}(?:まとめ|要約).{0,12}(?:保存|ナレッジ)/u.test(message);
}
__name(isConversationSummaryRequest, "isConversationSummaryRequest");
function extractReorganizationQuery(message) {
  const match2 = message.match(/^\s*(.{2,120}?)\s*(?:を\s*)?(?:再整理して|整理し直して|もう一度整理して|再整理)\s*[。.!！]?\s*$/u);
  return match2?.[1]?.trim() || null;
}
__name(extractReorganizationQuery, "extractReorganizationQuery");
function isUndoRequest(message) {
  return /^(?:今のなし|さっきの(?:記録|メモ|追記)?(?:は)?なし|直前の(?:記録|メモ|追記)?(?:を)?(?:取り消して|戻して)|記録を取り消して)[。.!！]?$/u.test(message.trim());
}
__name(isUndoRequest, "isUndoRequest");
function isPolicyUndoRequest(message) {
  return /^(?:直前の|最後の)?改善(?:案|設定)?(?:を)?(?:戻して|取り消して|元に戻して)[。.!！]?$/u.test(message.trim());
}
__name(isPolicyUndoRequest, "isPolicyUndoRequest");
function isImprovementApproval(message) {
  return /^(?:改善案を)?(?:反映して|それでいこう|それでいいよ|その設定で|次からそうして)[。.!！]?$/u.test(message.trim());
}
__name(isImprovementApproval, "isImprovementApproval");
function isImprovementRejection(message) {
  return /^(?:その)?改善案(?:は)?(?:やめて|却下して|取り下げて)[。.!！]?$/u.test(message.trim());
}
__name(isImprovementRejection, "isImprovementRejection");
function isImprovementStatusRequest(message) {
  return /(?:改善候補|改善案|反映待ち).{0,8}(?:見せて|一覧|ある|確認|どうなってる)|(?:改善候補|改善案)は[？?]$/u.test(message.trim());
}
__name(isImprovementStatusRequest, "isImprovementStatusRequest");
function isFolderOrganizationRequest(message) {
  return /(?:フォルダ|フォルダー|ディレクトリ).{0,12}(?:整理|分類|構成を見直|再編)|(?:ノート|メモ).{0,12}(?:フォルダ|フォルダー).{0,12}(?:整理|移動案)/u.test(message.trim());
}
function isFolderOrganizationApproval(message) {
  return /^(?:フォルダ|フォルダー)整理案を(?:反映して|実行して|適用して)[。.!！]?$/u.test(message.trim());
}
function isFolderOrganizationRejection(message) {
  return /^(?:フォルダ|フォルダー)整理案を(?:却下して|取り下げて|やめて)[。.!！]?$/u.test(message.trim());
}
function validateOrganizationPath(value) {
  if (typeof value !== "string") return null;
  const path = value.normalize("NFC").replaceAll("\\", "/").trim();
  if (!path || path.length > 300 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/u.test(part))) return null;
  return path.toLowerCase().endsWith(".md") ? path : path + ".md";
}
function isMemoryProcessingCandidate(message) {
  if (typeof message !== "string" || message.trim().length < 12) return false;
  return /(?:記録|覚え|保存|メモ|今後|これから|私は|僕は|自分は|好き|苦手|嫌い|好み|方針|決め|重要|必ず|してほしい|しないで|やめて|希望|制約|条件|使っている|利用している|普段|いつも|改善|回答|返答|検索|応答|機能|精度|パーソナライズ|遅い|長い|重い|遅延|待ち時間|時間がかか|不便|使いづら|使いにく|もっと|短く|長く|bot|assistant|I prefer|I like|remember|don't remember)/iu.test(message);
}
__name(isMemoryProcessingCandidate, "isMemoryProcessingCandidate");
  return { isConversationSummaryRequest, extractReorganizationQuery, isUndoRequest, isPolicyUndoRequest, isImprovementApproval, isImprovementRejection, isImprovementStatusRequest, isFolderOrganizationRequest, isFolderOrganizationApproval, isFolderOrganizationRejection, validateOrganizationPath, isMemoryProcessingCandidate };
}
