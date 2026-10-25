import test from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_CATEGORIES,
  hasSensitiveCategory,
  inspectAndRedact,
  inspectWholeContent,
  planTelegramHistory,
  selectAiSafeHistory,
  selectSafeParagraphs
} from "../src/ai-send-guard.mjs";

const env = { PRIVACY_BLOCKLIST: "" };

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

test("selectSafeParagraphs: 混在ノートは機微語の段落も含め全段落を返す（方針変更）", () => {
  const note = [
    "Unityのシェーダー課題の進め方をまとめる。",
    "先月から通院しているので、締め切りに余裕を持たせたい。",
    "Gitのブランチは機能ごとに分ける。"
  ].join("\n\n");
  const result = selectSafeParagraphs(note);
  assert.equal(result.ok, true);
  assert.equal(result.paragraphs.length, 3);
  const joined = result.paragraphs.join("\n");
  assert.ok(joined.includes("シェーダー"));
  assert.ok(joined.includes("ブランチ"));
  assert.ok(joined.includes("通院"), "機微語だけの段落は除外しない");
});

test("selectSafeParagraphs: 機微語だけのノートも段落をそのまま返す（保留にしない）", () => {
  const result = selectSafeParagraphs("口座番号を控えた。\n\n自宅住所は別紙。");
  assert.equal(result.ok, true);
  assert.equal(result.paragraphs.length, 2);
  assert.ok(result.paragraphs.join("").includes("口座番号"));
});

test("selectSafeParagraphs: 認証情報を含む段落があれば全体を送らない", () => {
  const result = selectSafeParagraphs("安全な段落。\n\napi_key=abcdef123456\n\n別の安全な段落。");
  assert.equal(result.ok, false);
  assert.deepEqual(result.paragraphs, []);
});

test("selectSafeParagraphs: 安全な段落の個人情報は伏字にして返し、空白だけの入力は空", () => {
  const result = selectSafeParagraphs("連絡は a@example.com まで。");
  assert.equal(result.ok, true);
  assert.ok(!result.paragraphs.join("").includes("a@example.com"));
  assert.deepEqual(selectSafeParagraphs("   \n\n  ").paragraphs, []);
  assert.deepEqual(selectSafeParagraphs(null).paragraphs, []);
});

test("selectSafeParagraphs: ユーザー定義のブロックリスト語は伏字になる", () => {
  const result = selectSafeParagraphs("プロジェクト蒼天の仕様メモ。", "蒼天");
  assert.ok(!result.paragraphs.join("").includes("蒼天"));
  assert.ok(result.paragraphs.join("").includes("[REDACTED]"));
});

test("inspectWholeContent: 長い本文の後ろの方にある認証情報も検出する", () => {
  const filler = "あ".repeat(30000);
  const credential = inspectWholeContent(filler + "\npassword=hunter2", env);
  assert.equal(credential.credentials, true);
  assert.equal(credential.ok, false);
});

test("inspectWholeContent: 機微語を含む長い本文もブロックしない（方針変更）", () => {
  const filler = "あ".repeat(30000);
  const sensitive = inspectWholeContent(filler + "通院の記録", env);
  assert.equal(sensitive.credentials, false);
  assert.equal(hasSensitiveCategory(sensitive.findings), false);
  assert.equal(sensitive.ok, true);
});

test("inspectWholeContent: 機微語のない通常のノートは何も検出しない", () => {
  const result = inspectWholeContent("Unityの勉強メモ。シェーダーの反射を実装した。", env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

// 語リストの誤検知 (例: 技術文の『診断』) は、リスト自体の廃止により解消した。
// 住所のような記述も、認証情報でなければブロック理由にならない。
test("『診断』を含む技術的な文もブロックされない（語リスト廃止）", () => {
  const result = inspectAndRedact("シェーダーの診断ツールを使った");
  assert.equal(result.ok, true);
  assert.equal(hasSensitiveCategory(result.findings), false);
  assert.equal(inspectAndRedact("東京都大田区の駅の近くに住んでいる").ok, true);
});

// #94 の機微語特例（原文のまま保存・記憶ジョブに積まない）は 2026-10-25 の
// 方針変更で廃止。通常の発言と同じく、伏字済み本文を保存し記憶ジョブに積む。
test("機微語を含む Telegram 発言も、伏字済み本文を保存し、記憶ジョブに積む（方針変更）", () => {
  const plan = planTelegramHistory("先月から通院していて、診断を受けました。連絡は test@example.com へ");
  assert.equal(plan.sensitive, false);
  assert.equal(plan.historyText, "先月から通院していて、診断を受けました。連絡は [EMAIL] へ");
  assert.equal(plan.queueMemory, true);
});

test("機微語を含まない発言は、伏字済みの本文を保存し、記憶ジョブに積む (#94)", () => {
  const plan = planTelegramHistory("連絡先は test@example.com です");
  assert.equal(plan.sensitive, false);
  assert.equal(plan.historyText, "連絡先は [EMAIL] です");
  assert.equal(plan.queueMemory, true);
});

test("認証情報を含む発言は、機微語があっても原文を保存しない (#94)", () => {
  const plan = planTelegramHistory("通院の記録。password=hunter2hunter2");
  assert.equal(plan.inspected.ok, false);
  assert.ok(!plan.historyText.includes("hunter2"));
  assert.ok(plan.historyText.includes("[CREDENTIAL_BLOCKED]"));
  assert.equal(plan.queueMemory, false);
});

test("AI へ送る履歴からは認証情報の行だけを除外し、機微語の行は伏字済みで含める（方針変更）", () => {
  const stored = [
    { role: "user", content: "先月から通院しています" },
    { role: "assistant", content: "お大事にしてください" },
    { role: "user", content: "明日は大学で発表です" },
    { role: "user", content: "連絡先は test@example.com です" },
    { role: "user", content: "password=hunter2hunter2" }
  ];
  const selected = selectAiSafeHistory(stored);
  assert.deepEqual(selected, [
    "User: 先月から通院しています",
    "Assistant: お大事にしてください",
    "User: 明日は大学で発表です",
    "User: 連絡先は [EMAIL] です"
  ]);
  // callGemini は送信直前に全文を検査する。選択後の履歴はその検査を通り、
  // 認証情報を含む全文は引き続き止まる。
  const gate = inspectWholeContent(selected.join("\n"), env);
  assert.equal(gate.ok, true);
  assert.equal(hasSensitiveCategory(gate.findings), false);
  const ungated = inspectWholeContent(stored.map((row) => row.content).join("\n"), env);
  assert.equal(ungated.ok, false);
});

test("AI へ送る履歴は、1 行あたりの文字数を maxChars で切り詰める (#94)", () => {
  const [line] = selectAiSafeHistory([{ role: "user", content: "あ".repeat(50) }], { maxChars: 10 });
  assert.equal(line, `User: ${"あ".repeat(10)}`);
});