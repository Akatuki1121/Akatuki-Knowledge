import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 保管庫の整理自動化・段階1の契約。段階1は分類と記録だけで、ノートを
// 変更しない。巡回のソースがノートを変える呼び出しを含まないこと、
// ai_allowed で遮断しないこと、常時除外と冒頭だけを渡す形を固定する。
const indexSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const storeSource = await readFile(new URL("../src/vault-organization-store.mjs", import.meta.url), "utf8");
const rulesSource = await readFile(new URL("../src/vault-organization-rules.mjs", import.meta.url), "utf8");

function sliceFunction(source, header, name) {
  const start = source.indexOf(header);
  const end = source.indexOf(`__name(${name}`, start);
  assert.ok(start >= 0 && end > start, name + " must exist");
  return source.slice(start, end);
}

const postPullSource = sliceFunction(indexSource, "async function runPostPullAutomation", "runPostPullAutomation");
assert.ok(postPullSource.includes("runVaultOrganizationScan(env)"), "the scan must run from runPostPullAutomation");

const scanIndexSource = sliceFunction(indexSource, "async function classifyVaultNoteWithAi", "classifyVaultNoteWithAi")
  + sliceFunction(indexSource, "async function runVaultOrganizationScan", "runVaultOrganizationScan");
const scanSources = scanIndexSource + "\n" + storeSource + "\n" + rulesSource;

// ノートを変える呼び出しを含まない。
for (const forbidden of [
  "correctNote(",
  "createNote(",
  "deleteNote(",
  "INSERT INTO notes",
  "UPDATE notes",
  "DELETE FROM notes",
  "/move",
]) {
  assert.ok(!scanSources.includes(forbidden), "stage-1 scan must not mutate notes: " + forbidden);
}

// ai_allowed でノートを遮断しない (2026-11-09 の所有者決定の維持)。
assert.ok(!scanSources.includes("ai_allowed"), "the scan must not gate notes by ai_allowed");

// 常時除外の名前とコンフリクト名の印が規則に含まれる。
assert.ok(rulesSource.includes("Akatuki-Knowledge E2E 発行用の環境変数"), "the always-excluded note name must be in the rules");
assert.ok(rulesSource.includes("(YAOS conflict"), "conflict-named files must be excluded in the rules");

// 走査は Notes/Inbox 配下だけを対象にする。
assert.ok(storeSource.includes("path LIKE 'Notes/Inbox/%'"), "the scan must only walk Notes/Inbox");

// Workers AI へは全文ではなく冒頭だけを渡し、送信直前の伏字を適用する。
assert.ok(storeSource.includes("slice(0, VAULT_ORGANIZATION_AI_HEAD_CHARS)"), "the scan must pass only the head to Workers AI");
assert.ok(scanIndexSource.includes("inspectAndRedact"), "material must be redacted right before sending");
assert.ok(scanIndexSource.includes('responseMimeType: "application/json"'), "the classification call must request JSON");

console.log("Vault organization contract checks passed.");
