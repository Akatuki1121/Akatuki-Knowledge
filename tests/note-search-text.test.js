// Issue #86: src/note-search-text.mjs のモジュール契約テスト。
// 検索テキスト処理 (capLikeTerm / searchTerms / excerpt) を index.js から
// 分離したため、文字列抽出ではなくモジュールの振る舞いで検証する
// (tests/reply-text.test.js と同じ方針)。3 関数とも純粋関数なので、
// スタブや D1 フェイクは不要。searchTermsUncapped は内部ヘルパーとして
// 公開していないため、searchTerms 経由で検証する。
import test from "node:test";
import assert from "node:assert/strict";
import { createNoteSearchText } from "../src/note-search-text.mjs";

const { capLikeTerm, searchTerms, excerpt } = createNoteSearchText();

test("capLikeTerm: 48 バイト以内の ASCII はそのまま返す", () => {
  assert.equal(capLikeTerm("a".repeat(48)), "a".repeat(48));
  assert.equal(capLikeTerm(""), "");
});

test("capLikeTerm: ASCII は 48 バイトで切り詰める (LIKE パターンの 50 バイト上限対策)", () => {
  assert.equal(capLikeTerm("a".repeat(60)), "a".repeat(48));
});

test("capLikeTerm: 3 バイト文字は 16 文字 = 48 バイトに収める", () => {
  assert.equal(capLikeTerm("あ".repeat(20)), "あ".repeat(16));
});

test("capLikeTerm: 4 バイト文字は途中で割らず 12 文字 = 48 バイトに収める", () => {
  assert.equal(capLikeTerm("😀".repeat(13)), "😀".repeat(12));
});

test("searchTerms: 空白区切りの複数語をそのまま検索語にする", () => {
  assert.deepEqual(searchTerms("alpha beta"), ["alpha", "beta"]);
});

test("searchTerms: ストップワード (探して / メモ / 検索) を除去する", () => {
  assert.deepEqual(searchTerms("探して 会議"), ["会議"]);
  assert.deepEqual(searchTerms("メモ 検索 テスト"), ["テスト"]);
});

test("searchTerms: 検索語は最大 8 件に制限する", () => {
  assert.deepEqual(
    searchTerms("w1 w2 w3 w4 w5 w6 w7 w8 w9 w10"),
    ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]
  );
});

test("searchTerms: ラテン語句を先に拾い、日本語の語も続けて拾う", () => {
  assert.deepEqual(searchTerms("Cloudflare Workers の使い方"), ["Cloudflare", "Workers", "の使い方"]);
});

test("searchTerms: 重複する語は 1 件にまとめる", () => {
  assert.deepEqual(searchTerms("alpha alpha beta"), ["alpha", "beta"]);
});

test("searchTerms: 日本語 12 文字以下は丸ごと 1 語にする", () => {
  assert.deepEqual(searchTerms("会議の日程"), ["会議の日程"]);
});

test("searchTerms: 日本語 13 文字以上は 3 文字 n-gram を最大 8 個作る (開始位置はステップ計算)", () => {
  assert.deepEqual(
    searchTerms("あいうえおかきくけこさしすせそたちつてと"),
    ["あいう", "うえお", "おかき", "きくけ", "けこさ", "さしす", "すせそ", "そたち"]
  );
});

test("searchTerms: 1 文字だけのクエリは検索語を作らない", () => {
  assert.deepEqual(searchTerms("あ"), []);
});

test("searchTerms: 長い 1 語は先頭 200 文字で切ってから 48 バイトに cap する", () => {
  assert.deepEqual(searchTerms("a".repeat(300)), ["a".repeat(48)]);
});

test("excerpt: コードフェンスを [code block] に置換する", () => {
  assert.equal(excerpt("前 ```code``` 後", "zzz"), "前 [code block] 後");
});

test("excerpt: 空白・改行を圧縮する", () => {
  assert.equal(excerpt("a\n\n  b\tc", "zzz"), "a b c");
});

test("excerpt: ヒット位置の 180 文字前から切り出し、先頭に省略記号を付ける", () => {
  const content = "x".repeat(300) + "needle" + "y".repeat(300);
  assert.equal(excerpt(content, "needle"), "…" + "x".repeat(180) + "needle" + "y".repeat(300));
});

test("excerpt: ヒットしない場合は先頭から切り出し、末尾に省略記号を付ける", () => {
  assert.equal(excerpt("a".repeat(1000), "zzz"), "a".repeat(600) + "…");
});

test("excerpt: 短い本文は省略記号なしで全文を返す", () => {
  assert.equal(excerpt("短い本文", "本文"), "短い本文");
});

test("excerpt: max 引数で切り出し長を変えられる", () => {
  assert.equal(excerpt("a".repeat(100), "zzz", 10), "a".repeat(10) + "…");
});

test("excerpt: 最も長い検索語を優先してヒット位置を決める", () => {
  const content = "z".repeat(200) + "abcdef" + "z".repeat(200) + "ab";
  assert.equal(
    excerpt(content, "ab abcdef"),
    "…" + "z".repeat(180) + "abcdef" + "z".repeat(200) + "ab"
  );
});
