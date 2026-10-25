// Issue #86: src/reply-text.mjs のモジュール契約テスト。
// AI 応答テキストの抽出・整形 (parseJsonObject / extractReplyFromJsonish /
// formatTelegramPlainText) を index.js から分離したため、文字列抽出ではなく
// モジュールの振る舞いで検証する (tests/ai-permission.test.js と同じ方針)。
// 3 関数とも純粋関数なので、スタブや D1 フェイクは不要。
import test from "node:test";
import assert from "node:assert/strict";
import { createReplyText } from "../src/reply-text.mjs";

const { extractReplyFromJsonish, formatTelegramPlainText, parseJsonObject } = createReplyText();

test("parseJsonObject: 素の JSON オブジェクトをそのまま解釈する", () => {
  assert.deepEqual(parseJsonObject('{"reply":"ok","source_ids":[1,2]}'), { reply: "ok", source_ids: [1, 2] });
});

test("parseJsonObject: ```json フェンスを取り除いて解釈する", () => {
  assert.deepEqual(parseJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
});

test("parseJsonObject: 前後の説明文から最初の { から最後の } までを切り出す", () => {
  assert.deepEqual(parseJsonObject('前置き {"a":{"b":2}} 後置き'), { a: { b: 2 } });
});

test("parseJsonObject: JSON を含まない入力では固定のエラーを投げる", () => {
  assert.throws(() => parseJsonObject("ただの文章"), { message: "AI response did not contain JSON" });
});

test("extractReplyFromJsonish: 正常な JSON から reply を取り出して trim する", () => {
  assert.equal(extractReplyFromJsonish('{"reply":"  回答です  ","source_ids":[]}'), "回答です");
});

test("extractReplyFromJsonish: フェンス付き JSON からも reply を取り出す", () => {
  assert.equal(extractReplyFromJsonish("```json\n{\"reply\":\"中身\"}\n```"), "中身");
});

test("extractReplyFromJsonish: 途中で切れた JSON でも完結した reply 文字列を救出する", () => {
  assert.equal(extractReplyFromJsonish('{"reply": "途中で切断", "source_ids": ['), "途中で切断");
});

test("extractReplyFromJsonish: reply 内のエスケープされた引用符を正しく解釈する", () => {
  assert.equal(extractReplyFromJsonish('{"reply": "彼は \\"はい\\" と言った", "x": '), '彼は "はい" と言った');
});

test("extractReplyFromJsonish: JSON でない素の文章はそのまま (trim して) 返す", () => {
  assert.equal(extractReplyFromJsonish("  そのままの回答  "), "そのままの回答");
});

test("formatTelegramPlainText: コードフェンスとバッククォートを除去する", () => {
  assert.equal(formatTelegramPlainText("```\ncode line\n``` と `inline`"), "code line\nと inline");
  assert.equal(formatTelegramPlainText("`inline` コード"), "inline コード");
});

test("formatTelegramPlainText: 強調マーカー (** __ ~~ == と単独の *) を除去する", () => {
  assert.equal(formatTelegramPlainText("**太字** と __下線__ と ~~打消~~ と ==蛍光== と *斜体*"), "太字 と 下線 と 打消 と 蛍光 と 斜体");
});

test("formatTelegramPlainText: 見出し記号と引用記号を行頭から取り除く", () => {
  assert.equal(formatTelegramPlainText("## 見出し\n> 引用文"), "見出し\n引用文");
});

test("formatTelegramPlainText: ウィキリンクは表示名だけに置換する", () => {
  assert.equal(formatTelegramPlainText("[[Notes/Page.md|表示名]] を参照"), "表示名 を参照");
  assert.equal(formatTelegramPlainText("[[Notes/sub/Page.md]] を参照"), "Page を参照");
});

test("formatTelegramPlainText: http(s) の Markdown リンクは「ラベル (URL)」に展開し、それ以外は触らない", () => {
  assert.equal(formatTelegramPlainText("[資料](https://example.com)"), "資料 (https://example.com)");
  assert.equal(formatTelegramPlainText("[資料](ftp://example.com)"), "[資料](ftp://example.com)");
});

test("formatTelegramPlainText: 連続する空行は1行に圧縮し、全体を trim する", () => {
  assert.equal(formatTelegramPlainText("\n\n行1\n\n\n\n行2\n\n"), "行1\n\n行2");
});
