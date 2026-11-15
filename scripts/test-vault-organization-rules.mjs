import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildVaultClassificationPrompt,
  checkVaultNoteExclusion,
  classifyVaultNoteByRules,
  parseVaultClassificationResponse,
  VAULT_ORGANIZATION_TARGET_FOLDERS,
} from "../src/vault-organization-rules.mjs";

// フィクスチャは本番で観測した形 (現在の Inbox の3件、バンドル内に残る
// 本番観測のパス形、日常の記録の形) を再現したもの。本文そのものは
// 写さず、形だけを使う。

test("exclusion X1: the E2E environment note is always excluded by path", () => {
  assert.deepEqual(
    checkVaultNoteExclusion({ path: "Notes/Inbox/Akatuki-Knowledge E2E 発行用の環境変数.md", title: "Akatuki-Knowledge E2E 発行用の環境変数" }),
    { ruleId: "X1" },
  );
});

test("exclusion X1: credential words in title fall to the suspicious side", () => {
  assert.deepEqual(
    checkVaultNoteExclusion({ path: "Notes/Inbox/APIキーの控え.md", title: "APIキーの控え" }),
    { ruleId: "X1" },
  );
});

test("exclusion X2: conflict-named files are out of scope", () => {
  assert.deepEqual(
    checkVaultNoteExclusion({ path: "Notes/Inbox/履歴 (YAOS conflict - disk from device-mv9dhgcw 2026-10-16T04-53-31Z).md", title: "履歴" }),
    { ruleId: "X2" },
  );
});

test("exclusion: ordinary notes are not excluded", () => {
  assert.equal(
    checkVaultNoteExclusion({ path: "Notes/Inbox/キューブマップ 一部 ムービー化.md", title: "キューブマップ 一部 ムービー化" }),
    null,
  );
});

test("K1: a date-prefixed daily record goes to Notes/日常", () => {
  const result = classifyVaultNoteByRules({
    title: "2026-11-15_日常の記録",
    contentHead: "曜日がずれて感じる一日だった。",
  });
  assert.equal(result.ruleId, "K1");
  assert.equal(result.targetPath, "Notes/日常");
  assert.equal(result.stage, 1);
});

test("K1: a diary-shaped note (date and weekday) goes to Notes/日常", () => {
  const result = classifyVaultNoteByRules({
    title: "週末の記録",
    contentHead: "2026年11月15日（土）\n私は午前中、家でのんびり過ごした。",
  });
  assert.equal(result.ruleId, "K1");
  assert.equal(result.targetPath, "Notes/日常");
});

test("K2: a unique folder name in the title decides the target", () => {
  const result = classifyVaultNoteByRules({
    title: "Tailscale の設定メモ",
    contentHead: "接続が切れたときの確認手順。",
  });
  assert.equal(result.ruleId, "K2");
  assert.equal(result.targetPath, "Notes/Tailscale");
});

test("K2: two folder names in the title do not decide", () => {
  assert.equal(
    classifyVaultNoteByRules({ title: "Purge と Tailscale の比較", contentHead: "両方を試した。" }),
    null,
  );
});

test("K3: Skybox with class context goes to プログラムワークショップIV", () => {
  const result = classifyVaultNoteByRules({
    title: "Unity：Skyboxの底面だけ動画化",
    contentHead: "第8回の課題。Skybox の底面のテクスチャを動画に差し替える。",
  });
  assert.equal(result.ruleId, "K3");
  assert.equal(result.targetPath, "Notes/プログラムワークショップIV");
});

test("K3: cubemap with class context goes to プログラムワークショップIV", () => {
  const result = classifyVaultNoteByRules({
    title: "キューブマップ 一部 ムービー化",
    contentHead: "演習の続き。キューブマップの一部をムービー化する。",
  });
  assert.equal(result.ruleId, "K3");
  assert.equal(result.targetPath, "Notes/プログラムワークショップIV");
});

test("K3: a topic word without class context does not decide", () => {
  assert.equal(
    classifyVaultNoteByRules({ title: "Skyboxの底面だけ動画化", contentHead: "底面のテクスチャを動画に差し替える。" }),
    null,
  );
});

test("contested words (原ゼミ, GPIO) are not decided by rules", () => {
  assert.equal(
    classifyVaultNoteByRules({ title: "原ゼミちゃん企画発表後", contentHead: "企画発表が終わった。次は試作を進める。" }),
    null,
  );
  assert.equal(
    classifyVaultNoteByRules({ title: "M5Stamp-C3 Mate GPIO 注意点・検証メモ", contentHead: "GPIO のプルアップ設定を検証した。" }),
    null,
  );
});

test("K4: a web clip shape is recorded as a stage-2 candidate without a target", () => {
  const result = classifyVaultNoteByRules({
    title: "スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台 ライフハッカー・ジャパン",
    contentHead: "この記事は、スマートバンドのセール情報を紹介します。公開日: 2026年10月",
  });
  assert.equal(result.ruleId, "K4");
  assert.equal(result.targetFolder, null);
  assert.equal(result.stage, 2);
});

test("an untitled generic note is not decided by rules", () => {
  assert.equal(
    classifyVaultNoteByRules({ title: "無題のファイル", contentHead: "短いメモ。" }),
    null,
  );
});

test("prompt lists only the target folders", () => {
  const prompt = buildVaultClassificationPrompt({ title: "題", contentHead: "冒頭" });
  for (const folder of VAULT_ORGANIZATION_TARGET_FOLDERS) {
    assert.ok(prompt.includes("- " + folder), "prompt must list " + folder);
  }
  assert.ok(!prompt.includes("AI共有"), "prompt must not offer AI共有");
  assert.ok(!prompt.includes("私について"), "prompt must not offer 私について");
});

test("parse: a decided JSON response", () => {
  const parsed = parseVaultClassificationResponse('{"target": "日常", "confidence": 0.9, "reason": "日記の形"}');
  assert.equal(parsed.decided, true);
  assert.equal(parsed.targetPath, "Notes/日常");
  assert.equal(parsed.confidence, 0.9);
});

test("parse: a fenced JSON response", () => {
  const parsed = parseVaultClassificationResponse("```json\n{\"target\": \"Purge\", \"confidence\": 0.5, \"reason\": \"\"}\n```");
  assert.equal(parsed.decided, true);
  assert.equal(parsed.target, "Purge");
});

test("parse: an explicit null target is a well-formed undecided", () => {
  const parsed = parseVaultClassificationResponse('{"target": null, "confidence": 0.2, "reason": "材料不足"}');
  assert.equal(parsed.decided, false);
  assert.equal(parsed.target, null);
  assert.equal(parsed.confidence, 0.2);
});

test("parse: unusable responses return null", () => {
  assert.equal(parseVaultClassificationResponse("分類できませんでした"), null);
  assert.equal(parseVaultClassificationResponse('{"target": "AI共有", "confidence": 0.9, "reason": ""}'), null);
  assert.equal(parseVaultClassificationResponse('{"target": "日常", "reason": ""}'), null);
  assert.equal(parseVaultClassificationResponse('{"target": "日常", "confidence": 1.5, "reason": ""}'), null);
  assert.equal(parseVaultClassificationResponse(""), null);
});

console.log("Vault organization rules tests passed.");
