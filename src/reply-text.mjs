// AI 応答テキストの抽出・整形 (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。3 関数はいずれも外部依存のない純粋関数で
// (extractReplyFromJsonish は同モジュールの parseJsonObject だけを使う)、
// このモジュールは Worker エントリポイントに依存しない。
// ファクトリ形式は src/gemini-client.mjs に揃えたが、
// 注入する依存はない。AI 送信可否の判定 (ai-send-guard) には触れない。

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// 応答テキスト処理の関数群を組み立てる。本文は移動前と同一。
export function createReplyText() {
function extractReplyFromJsonish(raw) {
  let text2 = String(raw || "").trim();
  const ticks = String.fromCharCode(96).repeat(3);
  if (text2.startsWith(ticks + "json")) text2 = text2.slice(7).trim();
  else if (text2.startsWith(ticks)) text2 = text2.slice(3).trim();
  if (text2.endsWith(ticks)) text2 = text2.slice(0, -3).trim();
  try {
    const parsed = parseJsonObject(text2);
    if (typeof parsed.reply === "string") return parsed.reply.trim();
  } catch {}
  const key = text2.indexOf('"reply"');
  if (key >= 0) {
    const colon = text2.indexOf(":", key + 7);
    const quote = text2.indexOf('"', colon + 1);
    if (colon >= 0 && quote >= 0) {
      let escaped = false;
      for (let i = quote + 1; i < text2.length; i++) {
        const code = text2.charCodeAt(i);
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) {
          try { return JSON.parse(text2.slice(quote, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return text2;
}
__name(extractReplyFromJsonish, "extractReplyFromJsonish");
function formatTelegramPlainText(value) {
  const ticks = String.fromCharCode(96);
  let text2 = String(value ?? "").replaceAll(ticks.repeat(3), "").replaceAll(ticks, "");
  for (const marker of ["**", "__", "~~", "=="]) text2 = text2.replaceAll(marker, "");
  text2 = text2.replaceAll("*", "");
  let lines = text2.split(String.fromCharCode(10)).map((line) => {
    let result = line.trimStart();
    while (result.startsWith("#")) result = result.slice(1);
    if (result.startsWith(" ")) result = result.slice(1);
    if (result.startsWith(">")) result = result.slice(1).trimStart();
    return result;
  });
  text2 = lines.join(String.fromCharCode(10));
  let start = 0;
  while ((start = text2.indexOf("[[", start)) >= 0) {
    const end = text2.indexOf("]]", start + 2);
    if (end < 0) break;
    const target = text2.slice(start + 2, end);
    const pipe = target.indexOf("|");
    let label = pipe >= 0 ? target.slice(pipe + 1) : target;
    if (pipe < 0) label = label.split("/").pop();
    if (label.toLowerCase().endsWith(".md")) label = label.slice(0, -3);
    text2 = text2.slice(0, start) + label + text2.slice(end + 2);
    start += label.length;
  }
  start = 0;
  while ((start = text2.indexOf("[", start)) >= 0) {
    const close = text2.indexOf("]", start + 1);
    if (close < 0) break;
    if (text2[close + 1] !== "(") { start = close + 1; continue; }
    const end = text2.indexOf(")", close + 2);
    if (end < 0) break;
    const url = text2.slice(close + 2, end);
    if (!url.startsWith("http://") && !url.startsWith("https://")) { start = end + 1; continue; }
    const label = text2.slice(start + 1, close);
    const replacement = label + " (" + url + ")";
    text2 = text2.slice(0, start) + replacement + text2.slice(end + 1);
    start += replacement.length;
  }
  lines = text2.split(String.fromCharCode(10));
  const clean = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = !line.trim();
    if (blank && previousBlank) continue;
    clean.push(line.trimEnd());
    previousBlank = blank;
  }
  return clean.join(String.fromCharCode(10)).trim();
}
__name(formatTelegramPlainText, "formatTelegramPlainText");
function parseJsonObject(raw) {
  const text2 = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text2.indexOf("{");
  const end = text2.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain JSON");
  return JSON.parse(text2.slice(start, end + 1));
}
__name(parseJsonObject, "parseJsonObject");
  return { extractReplyFromJsonish, formatTelegramPlainText, parseJsonObject };
}
