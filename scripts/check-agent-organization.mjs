import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
for (const contract of [
  "isBulkAiPermissionRequest",
  "isBulkAiPermissionApproval",
  "isBulkAiPermissionRejection",
  "inspectBulkAiPermissionCandidates",
  "inspectWholeContent(note.content || \"\", env).credentials",
  "AI送信許可の一括反映待ちです",
  "AI送信許可を一括反映して",
  "env.DB.batch(batch)",
  "sensitivity = 'user-approved'",
  "AI送信許可の一括確認が完了しました"
]) {
  assert.ok(source.includes(contract), "Missing Telegram bulk AI permission safety contract: " + contract);
}

const migration = await readFile(new URL("../migrations/pending/0010_bot_organization_candidates.sql", import.meta.url), "utf8");

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

console.log("Agent organization contract checks passed.");
