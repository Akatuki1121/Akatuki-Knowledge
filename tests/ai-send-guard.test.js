import test from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_CATEGORIES,
  hasSensitiveCategory,
  inspectAndRedact
} from "../src/ai-send-guard.mjs";

test("機微カテゴリの定義は互換のため残るが、検査はカテゴリを findings に出さない", () => {
  assert.deepEqual([...SENSITIVE_CATEGORIES], ["health", "financial", "location"]);
  assert.equal(hasSensitiveCategory(["health"]), true);
  assert.equal(hasSensitiveCategory(["email", "credentials"]), false);
  assert.equal(hasSensitiveCategory(undefined), false);
});

// 2026-10-25 の所有者方針変更: 送信ブロックは認証情報の検出のみ。
// 機微語リスト (診断・クローン病・服薬・部屋番号・金融系など) の一致は
// カテゴリ findings を生まず、ブロック理由にもならない。
test("機微語を含む入力でも、カテゴリ検出は行わずブロックしない（方針変更）", () => {
  for (const [text, category] of [
    ["先月から通院している", "health"],
    ["クレジットカード番号を控えた", "financial"],
    ["自宅住所をメモ", "location"]
  ]) {
    const result = inspectAndRedact(text);
    assert.ok(!result.findings.includes(category), `${category} must not be reported for: ${text}`);
    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
  }
});

test("認証情報は ok:false で本文が伏字になり、機微判定とは別に扱われる", () => {
  const result = inspectAndRedact("password=hunter2 と書いてある");
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.ok(result.findings.includes("credentials"));
  assert.ok(!result.text.includes("hunter2"));
});

test("メール・電話は伏字にして送信可能のまま返す", () => {
  const result = inspectAndRedact("連絡先は a@example.com と 03-1234-5678");
  assert.equal(result.ok, true);
  assert.ok(!result.text.includes("a@example.com"));
  assert.ok(!result.text.includes("03-1234-5678"));
});

// 語リストの誤検知 (例: 技術文の『診断』) は、リスト自体の廃止により解消した。
// 住所のような記述も、認証情報でなければブロック理由にならない。
test("『診断』を含む技術的な文もブロックされない（語リスト廃止）", () => {
  const result = inspectAndRedact("シェーダーの診断ツールを使った");
  assert.equal(result.ok, true);
  assert.equal(hasSensitiveCategory(result.findings), false);
  assert.equal(inspectAndRedact("東京都大田区の駅の近くに住んでいる").ok, true);
});

// 2026-11-09 の所有者決定で、ノート書き込み時の本文全体スキャン
// (inspectWholeContent) と Telegram 履歴向けの関数群は撤去した。
// このファイルで検証するのは、残った inspectAndRedact の送信直前の
// 伏字・検出だけである。ノートが遮断されずに保存されることは
// tests/note-create-no-gate.test.js が createNote の実挙動で確かめる。
