import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 保管庫の整理自動化 (段階2) の契約検査。次をソースの形で固定する。
// - 巡回と規則は、ノートの削除・作成・直接の書き換えを一切含まない。
//   変更は注入された実行関数 (index.js の公開 API 経路の内部呼び出し)
//   経由でだけ起きる。
// - 移動の経路 (/move) は、公開ルーターと段階2の実行関数の2か所にしか
//   現れない。実行は、記録が書けた場合に限る形 (store 側の gate) で
//   組まれ、AI の分類だけで決まった段1には実行関数が結びつかない。
// - 実行関数は、実行直前の本文・ハッシュ照合と、実行後の同一性・
//   内容の照合を持つ (R2・R3・R4)。
// - 巡回は ai_allowed を見ない (所有者 2026-11-09 の決定)。
// - 常時除外の名前が規則の中に在る。本文を開かずに判定できる形。
// - 巡回は Inbox 配下だけを対象にし、pull 後の自動処理から走る。
// - Workers AI へ渡すのは題と本文の冒頭だけ。本文の全文は渡さない。
// - 記録の読み口は認証の内側に在り、記録テーブルは 0020 の
//   マイグレーションで用意される (適用は人間の手順で完了済み)。

const indexSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const storeSource = await readFile(new URL("../src/vault-organization-store.mjs", import.meta.url), "utf8");
const rulesSource = await readFile(new URL("../src/vault-organization-rules.mjs", import.meta.url), "utf8");
const migrationSource = await readFile(
  new URL("../migrations/0020_vault_organization_records.sql", import.meta.url),
  "utf8",
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const classifySlice = sliceBetween(indexSource, "async function classifyVaultNoteWithAi(", "async function runVaultOrganizationScan(");
const runScanSlice = sliceBetween(indexSource, "async function runVaultOrganizationScan(", "async function executeVaultOrganizationMove(");
const executorSlice = sliceBetween(
  indexSource,
  "async function executeVaultOrganizationMove(",
  '__name(executeVaultOrganizationFormat, "executeVaultOrganizationFormat");',
);
const postPullSlice = sliceBetween(indexSource, "async function runPostPullAutomation(", "async function runImprovementInbox(");

// --- 変更経路の閉じ方 -------------------------------------------------

for (const [name, source] of [["store", storeSource], ["rules", rulesSource]]) {
  for (const forbidden of ["deleteNote(", "DELETE FROM notes", "INSERT INTO notes", "UPDATE notes", "correctNote(", "createNote(", "moveNote("]) {
    assert.ok(!source.includes(forbidden), `${name} must not contain ${forbidden} (changes go through the injected executors)`);
  }
}
assert.ok(!storeSource.includes("/move"), "the store must not reference the move route directly");
assert.equal(
  indexSource.split('"/move"').length - 1,
  2,
  "the /move route may appear only in the public router and in the stage-2 executor",
);
assert.ok(executorSlice.includes('"/move"'), "the executor must use the public move route");

// --- 実行の gate と照合 ----------------------------------------------

assert.ok(
  storeSource.includes("if (!recordsAvailable) return false"),
  "record writes must fall back to no-record mode when the table is missing",
);
assert.ok(
  storeSource.includes("if (recorded && executeMove)"),
  "stage-1 moves must be gated on the classification record being written",
);
assert.ok(
  storeSource.includes('rule?.ruleId === "K4" ? await attemptFormat(note, recorded) : null'),
  "formatting must stay limited to K4-classified notes",
);
for (const marker of [
  "https://internal",
  "expectedContentHash",
  "content_changed_since_classification",
  "move_verification_failed",
  "format_verification_failed",
  "moveNote(request, route, env)",
  "correctNote(request, route, env)",
]) {
  assert.ok(executorSlice.includes(marker), `the executors must contain ${marker}`);
}
assert.ok(
  rulesSource.includes("export function normalizeVaultNoteWhitespace") && rulesSource.includes("export function isWhitespaceOnlyChange"),
  "whitespace normalization and the R4 check must live in the rules module",
);

// --- ai_allowed を見ない (所有者 2026-11-09 の決定) --------------------

for (const [name, source] of [
  ["store", storeSource],
  ["rules", rulesSource],
  ["classify", classifySlice],
  ["runScan", runScanSlice],
  ["executors", executorSlice],
]) {
  assert.ok(!source.includes("ai_allowed"), `${name} must not reference ai_allowed`);
}

// --- 除外と対象範囲 ----------------------------------------------------

assert.ok(rulesSource.includes("Akatuki-Knowledge E2E 発行用の環境変数"), "the credential note exclusion must stay in the rules");
assert.ok(rulesSource.includes("(YAOS conflict"), "conflict-named files must stay excluded in the rules");
assert.ok(storeSource.includes("path LIKE 'Notes/Inbox/%'"), "the scan must stay inside Notes/Inbox");
assert.ok(!storeSource.includes("Notes/AI共有") && !rulesSource.includes('"AI共有"'), "AI-shared notes must not be organization targets");

// --- Workers AI へ渡す材料 ---------------------------------------------

assert.ok(classifySlice.includes("contentHead"), "classification must receive only the head of the content");
assert.ok(!/\.content(?!Head)/.test(classifySlice), "classification must not receive the full content");
assert.ok(classifySlice.includes("inspectAndRedact("), "classification material must pass the pre-send redaction");
assert.ok(classifySlice.includes('responseMimeType: "application/json"'), "classification must request a JSON response");

// --- 巡回の接続と読み口 -------------------------------------------------

assert.ok(runScanSlice.includes("scanVaultOrganizationInbox(env.DB"), "runVaultOrganizationScan must delegate to the store scan");
assert.ok(runScanSlice.includes("executeMove") && runScanSlice.includes("executeFormat"), "the scan must inject the stage-2 executors");
assert.ok(postPullSlice.includes("runVaultOrganizationScan(env)"), "the scan must run from the post-pull automation");
assert.ok(indexSource.includes('url.pathname === "/api/organization/records"'), "the records endpoint must exist");
assert.ok(indexSource.includes("listVaultOrganizationRecords(env.DB"), "the records endpoint must read through the store");

// --- 記録テーブルは 0020 のマイグレーション ---------------------------

assert.ok(migrationSource.includes("CREATE TABLE vault_organization_records"), "the records table migration must be present");
assert.ok(migrationSource.includes("content_hash_before") && migrationSource.includes("content_hash_after"), "records must keep before/after hashes");

console.log("Vault organization contract checks passed.");
