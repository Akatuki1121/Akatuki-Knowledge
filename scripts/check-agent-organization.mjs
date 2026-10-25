import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// 残る AI 送信面の安全契約: /api/ai-preview、自動整理 (organize.mjs)、
// 背景タスクのコンテキスト検索、Gemini 境界。
// Telegram チャット対話 (一括 AI 送信許可・フォルダ整理・会話要約・/save) の
// 契約は、ボット廃止に伴いこのチェックからも外した。
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const geminiClientSource = await readFile(new URL("../src/gemini-client.mjs", import.meta.url), "utf8");

const previewStart = source.indexOf("function buildAiPreview");
const previewEnd = source.indexOf("\nasync function ", previewStart + 30);
const previewSource = source.slice(previewStart, previewEnd);
assert.ok(previewStart >= 0 && previewEnd > previewStart, "buildAiPreview must exist");
assert.ok(previewSource.includes('hasSensitiveCategory(wholeNote.findings)'), "AI previews must exclude sensitive notes from the outgoing payload");
assert.ok(previewSource.includes('reason: "sensitive_info_requires_confirmation"'), "AI preview must explain why sensitive notes were excluded");
assert.ok(previewSource.includes("inspectAndRedact("), "AI preview payloads must be checked at the outbound boundary");
assert.ok(previewSource.includes('hasSensitiveCategory(inspectedQuestion.findings)'), "AI previews must block sensitive questions before sending");

const organizeSource = await readFile(new URL("../src/organize.mjs", import.meta.url), "utf8");
assert.ok(organizeSource.includes("async function organizePending"), "organizePending must exist in src/organize.mjs");
assert.ok(organizeSource.includes("selectSafeParagraphs(note.content"), "Sensitive notes must retain safe passages for automatic organization");
assert.ok(organizeSource.includes("selectedParagraphs.ok"), "Sensitive passages must be inspected before building the AI prompt");
assert.ok(organizeSource.includes('hasSensitiveCategory('), "Health, financial, and location-sensitive passages must be excluded from outbound content");
assert.ok(organizeSource.includes("const safeContent = selectedParagraphs.paragraphs.join"), "Automatic organization must use only the inspected safe passages");
assert.ok(organizeSource.includes('"[機微情報を含む項目]"'), "Sensitive titles must be replaced before outbound processing");
assert.ok(organizeSource.includes("if (!safeContent)"), "Notes without any safe passages must not be falsely marked organized");
assert.ok(organizeSource.includes("review_state = 'pending_confirmation'"), "Wholly sensitive notes must wait for explicit review when safe organization is impossible");
assert.ok(organizeSource.includes("summary = ?, ai_tags_json = ?, related_json = ?, knowledge_type = ?, knowledge_scope = ?"), "Notes with safe passages must receive actual organization metadata");
assert.ok(!organizeSource.includes("SET ai_allowed = 0, review_state = 'pending_confirmation', sensitivity = 'sensitive'"), "Sensitive categories alone must not remove notes from the organization queue");
assert.ok(!organizeSource.includes("SET content ="), "Organization must never overwrite the original note body");

const taskNotesStart = source.indexOf("async function searchAgentTaskNotes");
const taskNotesEnd = source.indexOf("__name(searchAgentTaskNotes", taskNotesStart);
const taskNotesSource = source.slice(taskNotesStart, taskNotesEnd);
assert.ok(taskNotesStart >= 0 && taskNotesEnd > taskNotesStart, "searchAgentTaskNotes must exist");
assert.ok(taskNotesSource.includes('hasSensitiveCategory(wholeInspection.findings)'), "Background tasks must exclude sensitive notes from their context");

const geminiStart = geminiClientSource.indexOf("async function callGemini");
const geminiEnd = geminiClientSource.indexOf("__name(callGemini", geminiStart);
const geminiSource = geminiClientSource.slice(geminiStart, geminiEnd);
assert.ok(geminiStart >= 0 && geminiEnd > geminiStart, "callGemini must exist");
assert.ok(geminiSource.includes('hasSensitiveCategory(privacyCheck.findings)'), "The final Gemini boundary must reject sensitive payloads regardless of caller");

console.log("Agent organization contract checks passed.");
