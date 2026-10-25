// 検索テキスト処理 (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。いずれも外部依存のない純粋関数で
// (excerpt は同モジュールの searchTerms だけを使う)、
// このモジュールは Worker エントリポイントに依存しない。
// ファクトリ形式は src/reply-text.mjs に揃えたが、
// 注入する依存はない。検索 SQL 本体 (findRelevantNotes) は移動していない。

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// 検索テキスト処理の関数群を組み立てる。本文は移動前と同一。
// searchTermsUncapped は内部ヘルパーとして公開しない。
export function createNoteSearchText() {
// D1 rejects LIKE patterns longer than 50 bytes ("LIKE or GLOB pattern too complex"). The pattern is %term%, so cap each term at 48 UTF-8 bytes.
function capLikeTerm(term) {
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  for (const ch of term) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 48) break;
    out += ch;
    bytes += size;
  }
  return out;
}
__name(capLikeTerm, "capLikeTerm");

function searchTerms(q) {
  return [...new Set(searchTermsUncapped(q).map(capLikeTerm).filter((term) => [...term].length >= 2))];
}
__name(searchTerms, "searchTerms");

function searchTermsUncapped(q) {
  const trimmed = q.trim().slice(0, 200);
  const terms = /* @__PURE__ */ new Set();
  const spaced = trimmed.split(/[\s,，、。.!?！？:：;；()（）\[\]{}「」『』]+/u).filter((x) => x.length >= 2);
  const compact = trimmed.replace(/[\s,，、。.!?！？:：;；()（）\[\]{}「」『』]/gu, "");
  const chars = [...compact];
  const latinTerms = trimmed.match(/[A-Za-z][A-Za-z0-9._+-]{1,49}/g) || [];
  const stopWords = new Set(["探して", "探す", "検索", "メモ", "ノート", "に関する", "について", "教えて", "関連する", "ある", "ください"]);
  for (const term of latinTerms) terms.add(term);
  if (spaced.length > 1) {
    for (const term of spaced) if (!stopWords.has(term)) terms.add(term.slice(0, 50));
    return [...terms].slice(0, 8);
  }
  if (latinTerms.length) return [...terms].slice(0, 8);
  if (chars.length <= 12) return chars.length >= 2 ? [compact] : [];
  const width = 3;
  const maxNgrams = 8;
  const maxStart = chars.length - width;
  const step = Math.max(1, Math.floor(maxStart / (maxNgrams - 1)));
  for (let i = 0; i <= maxStart && terms.size < maxNgrams; i += step) {
    terms.add(chars.slice(i, i + width).join(""));
  }
  return [...terms].slice(0, maxNgrams);
}
__name(searchTermsUncapped, "searchTermsUncapped");
function excerpt(content, q, max2 = 600) {
  const clean = content.replace(/```[\s\S]*?```/g, "[code block]").replace(/\s+/g, " ").trim();
  const terms = searchTerms(q).sort((a, b) => b.length - a.length);
  const lower = clean.toLocaleLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term.toLocaleLowerCase());
    if (at >= 0) break;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 180);
  return (start > 0 ? "\u2026" : "") + clean.slice(start, start + max2) + (start + max2 < clean.length ? "\u2026" : "");
}
__name(excerpt, "excerpt");
  return { capLikeTerm, searchTerms, excerpt };
}
