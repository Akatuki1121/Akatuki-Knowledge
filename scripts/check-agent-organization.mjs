import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
for (const contract of [
  "isBulkAiPermissionRequest",
  "isBulkAiPermissionApproval",
  "isBulkAiPermissionRejection",
  "inspectBulkAiPermissionCandidates",
  "const inspection = inspectWholeContent(content, env)",
  "AI送信許可の一括反映待ちです",
  "AI送信許可を一括反映して",
  "sensitivity = 'user-approved'",
  "sensitivity = 'credentials'",
  "content_hash IS ? AND content = ?",
  "内容変更・状態変化・競合で見送り",
  "AI送信許可の一括確認が完了しました",
  "bot_ai_permission_previews",
  "hashBulkAiPermissionContent",
  "expires_at",
  "Date.parse(preview.expires_at) <= Date.now()",
  "確認時点の対象ノートだけを反映します",
  "candidates.length > 1000",
  "AND id IN (",
  "env.DB.batch(statements)"
]) {
  assert.ok(source.includes(contract), "Missing Telegram bulk AI permission safety contract: " + contract);
}

const previewMigration = await readFile(new URL("../migrations/0012_bot_ai_permission_previews.sql", import.meta.url), "utf8");
for (const contract of [
  "CREATE TABLE bot_ai_permission_previews",
  "chat_id TEXT PRIMARY KEY",
  "candidates_json TEXT NOT NULL",
  "expires_at TEXT NOT NULL",
  "CHECK (status IN ('pending'))",
  "idx_bot_ai_permission_previews_expiry"
]) {
  assert.ok(previewMigration.includes(contract), "Missing bulk AI permission preview schema contract: " + contract);
}

const migration = await readFile(new URL("../migrations/0010_bot_organization_candidates.sql", import.meta.url), "utf8");

for (const contract of [
  "isFolderOrganizationRequest",
  "isFolderOrganizationApproval",
  "isFolderOrganizationRejection",
  "proposeFolderOrganization",
  "applyLatestFolderOrganization",
  "rejectLatestFolderOrganization",
  "inspectWholeContent(note.content || \"\", env).credentials",
  "note.path !== candidate.source_path",
  "await enqueueSyncJob(env, \"notes\", note.id, \"upsert\")",
  "INSERT INTO note_revisions",
  "status = 'applied'",
  "status = 'rejected'"
]) {
  assert.ok(source.includes(contract), "Missing folder organization safety contract: " + contract);
}

for (const contract of [
  "CREATE TABLE bot_organization_candidates",
  "source_path TEXT NOT NULL",
  "target_path TEXT NOT NULL",
  "CHECK (status IN ('pending', 'applied', 'rejected'))",
  "idx_bot_organization_candidates_pending"
]) {
  assert.ok(migration.includes(contract), "Missing folder organization schema contract: " + contract);
}

for (const contract of [
  'inspection.findings.some((finding) => ["health", "financial", "location"].includes(finding))',
  'const sensitiveCandidates = []',
  '["allow", scan.eligible], ["revoke", scan.credentialAllowed], ["hold", scan.sensitiveCandidates]',
  'candidate.action === "hold"',
  "review_state = 'pending_confirmation'",
  'const sensitiveFindings = inspected.findings.filter((finding) => ["health", "financial", "location"].includes(finding))',
  "機微情報のため確認待ち"
]) {
  assert.ok(source.includes(contract), "Missing sensitive-note review gate: " + contract);
}

const answerStart = source.indexOf("async function answerTelegramMessage");
const answerEnd = source.indexOf("\nasync function ", answerStart + 30);
const answerSource = source.slice(answerStart, answerEnd);
assert.ok(answerSource.includes("const wholeInspection = inspectWholeContent(note.content, env)"), "Chat answers must inspect the complete source note before prompt construction");
assert.ok(answerSource.includes('wholeInspection.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "Chat answer prompts must not include notes flagged as health, financial, or location-sensitive");
assert.ok(answerSource.includes("continue;"), "Sensitive source notes must be skipped without mutating the stored note");
assert.ok(answerSource.includes("inspectAndRedact("), "Chat answer payloads must be checked at the outbound boundary");

const previewStart = source.indexOf("function buildAiPreview");
const previewEnd = source.indexOf("\nasync function ", previewStart + 30);
const previewSource = source.slice(previewStart, previewEnd);
assert.ok(previewSource.includes('wholeNote.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "AI previews must exclude sensitive notes from the outgoing payload");
assert.ok(previewSource.includes('reason: "sensitive_info_requires_confirmation"'), "AI preview must explain why sensitive notes were excluded");
assert.ok(previewSource.includes("inspectAndRedact("), "AI preview payloads must be checked at the outbound boundary");

const holdStart = source.indexOf("const sensitiveFindings = inspected.findings.filter");
const holdEnd = source.indexOf('stage = "prompt_build"', holdStart);
const holdSource = source.slice(holdStart, holdEnd);
assert.ok(holdSource.includes("SET ai_allowed = 0, review_state = 'pending_confirmation', sensitivity = 'sensitive'"), "Sensitive notes must be held from organization");
assert.ok(!holdSource.includes("content ="), "Holding a sensitive note must not overwrite its original content");

const folderStart = source.indexOf("async function proposeFolderOrganization");
const folderEnd = source.indexOf("async function applyLatestFolderOrganization", folderStart);
const folderSource = source.slice(folderStart, folderEnd);
assert.ok(folderSource.includes('!inspectWholeContent(note.content || "", env).credentials'), "Folder organization may exclude credentials, but not notes merely because they contain health, financial, or location information");
assert.ok(!folderSource.includes('findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "Sensitive categories must not blanket-exclude notes from automatic organization");

console.log("Agent organization contract checks passed.");
