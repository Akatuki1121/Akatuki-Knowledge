import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
for (const contract of [
  "isBulkAiPermissionRequest",
  "isBulkAiPermissionApproval",
  "isBulkAiPermissionRejection",
  "inspectBulkAiPermissionCandidates",
  "inspectWholeContent(content, env).credentials",
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

console.log("Agent organization contract checks passed.");
