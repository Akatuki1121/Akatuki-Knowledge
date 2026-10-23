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
  "const inspection = inspectWholeContent(note.content || \"\", env)",
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
  "UPDATE notes SET sensitivity = 'sensitive', review_state = 'ready'",
  'const sensitiveFindings = inspected.findings.filter((finding) => ["health", "financial", "location"].includes(finding))',
  "機微情報を含むノート"
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

const organizeStart = source.indexOf("async function organizePending");
const organizeEnd = source.indexOf("\nasync function ", organizeStart + 30);
const organizeSource = source.slice(organizeStart, organizeEnd);
assert.ok(organizeSource.includes("const sensitiveFindings = inspected.findings.filter"), "Organization must detect sensitive categories");
assert.ok(organizeSource.includes("never send their body or title to Gemini"), "Sensitive notes must remain eligible for organization without sending their body to Gemini");
assert.ok(organizeSource.includes('"[機微情報を含むノート]"'), "Sensitive titles must be replaced with a generic label before outbound processing");
assert.ok(organizeSource.includes("SET summary = CASE WHEN ? = 1 THEN summary ELSE ? END"), "Sensitive notes must preserve their existing summary");
assert.ok(organizeSource.includes("ai_tags_json = CASE WHEN ? = 1 THEN ai_tags_json ELSE ? END"), "Sensitive notes must preserve their existing AI tags");
assert.ok(organizeSource.includes("related_json = CASE WHEN ? = 1 THEN related_json ELSE ? END"), "Sensitive notes must preserve their existing related-note links");
assert.ok(organizeSource.includes("sensitiveFindings.length ? 1 : 0, JSON.stringify(tags), sensitiveFindings.length ? 1 : 0, JSON.stringify(linkedIds)"), "Metadata bindings must match the conditional update statement");
assert.ok(!organizeSource.includes("SET ai_allowed = 0, review_state = 'pending_confirmation', sensitivity = 'sensitive'"), "Sensitive categories alone must not remove notes from the organization queue");
assert.ok(!organizeSource.includes("SET content ="), "Organization must never overwrite the original note body");

const folderStart = source.indexOf("async function proposeFolderOrganization");
const folderEnd = source.indexOf("async function applyLatestFolderOrganization", folderStart);
const folderSource = source.slice(folderStart, folderEnd);
assert.ok(folderSource.includes("!inspectWholeContent(note.content || \"\", env).credentials"), "Folder organization must exclude notes with credentials");
assert.ok(!folderSource.includes("!inspection.findings.some"), "Sensitive categories alone must not exclude notes from folder organization");
assert.ok(folderSource.includes("const safeField = (value)"), "Folder organization must sanitize outbound metadata for sensitive fields");
assert.ok(folderSource.includes('"[機微情報を含む項目]"'), "Sensitive title, path, or summary fields must be replaced before outbound processing");

const summaryStart = source.indexOf("async function summarizeConversationToKnowledge");
const summaryEnd = source.indexOf("function isFolderOrganizationRequest", summaryStart);
const summarySource = source.slice(summaryStart, summaryEnd);
assert.ok(summarySource.includes("results.reverse().flatMap"), "Conversation summaries must build an outbound-safe copy of history");
assert.ok(summarySource.includes('["health", "financial", "location"].includes(finding)'), "Sensitive history messages must be excluded from AI summaries without altering stored history");

assert.ok(answerSource.includes('safeMessage.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "Sensitive current messages must not be sent to Gemini");
assert.ok(answerSource.includes("history.results.reverse().flatMap"), "Chat prompts must filter sensitive stored history at send time");

assert.ok(previewSource.includes('inspectedQuestion.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "AI previews must block sensitive questions before sending");

const taskNotesStart = source.indexOf("async function searchAgentTaskNotes");
const taskNotesEnd = source.indexOf("__name(searchAgentTaskNotes", taskNotesStart);
const taskNotesSource = source.slice(taskNotesStart, taskNotesEnd);
assert.ok(taskNotesSource.includes('wholeInspection.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "Background tasks must exclude sensitive notes from their context");

const geminiStart = source.indexOf("async function callGemini");
const geminiEnd = source.indexOf("__name(callGemini", geminiStart);
const geminiSource = source.slice(geminiStart, geminiEnd);
assert.ok(geminiSource.includes('privacyCheck.findings.some((finding) => ["health", "financial", "location"].includes(finding))'), "The final Gemini boundary must reject sensitive payloads regardless of caller");

const storeStart = source.indexOf("async function storeTelegramNote");
const storeEnd = source.indexOf("__name(storeTelegramNote", storeStart);
const storeSource = source.slice(storeStart, storeEnd);
assert.ok(storeSource.includes("title, content, content_hash"), "Telegram note storage must persist the original note content");
assert.ok(storeSource.includes(".bind(id2, chatId, String(messageId), title, content, contentHash"), "Telegram note storage must bind the original content, not the redacted AI prompt");
assert.ok(source.includes("storeTelegramNote(env, chatId, message.message_id, noteContent, now)"), "Explicit /save must preserve the user's supplied note text");


const organizeStart = source.indexOf("async function organizePending");
const organizeEnd = source.indexOf('__name(organizePending', organizeStart);
const organizeSource = source.slice(organizeStart, organizeEnd);
assert.ok(organizeSource.includes('const sensitiveFindings = inspected.findings.filter((finding) => ["health", "financial", "location"].includes(finding))'), "Automatic organization must detect sensitive categories without treating them as credentials");
assert.ok(!organizeSource.includes("review_state = 'pending_confirmation'"), "Sensitive categories alone must not permanently remove notes from the automatic organization queue");
assert.ok(organizeSource.includes('text: "[機微情報を含むノート]"'), "Sensitive note bodies must not be sent to Gemini");
assert.ok(organizeSource.includes('summary = CASE WHEN ? = 1 THEN summary ELSE ? END'), "Sensitive-note processing must preserve the existing summary when source text is withheld");
assert.ok(organizeSource.includes('ai_tags_json = CASE WHEN ? = 1 THEN ai_tags_json ELSE ? END'), "Sensitive-note processing must preserve existing AI tags when source text is withheld");
assert.ok(organizeSource.includes('related_json = CASE WHEN ? = 1 THEN related_json ELSE ? END'), "Sensitive-note processing must preserve existing related-note links when source text is withheld");
assert.ok(organizeSource.includes('organized_hash = ?'), "Processed notes must not be repeatedly retried every scheduled run");

console.log("Agent organization contract checks passed.");
