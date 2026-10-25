import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// 残る AI 送信面の安全契約: 背景タスクのコンテキスト検索。
// Telegram チャット対話 (一括 AI 送信許可・フォルダ整理・会話要約・/save) の
// 契約は、ボット廃止に伴いこのチェックからも外した。
// /api/ai-preview・自動整理 (organize.mjs)・Gemini 境界の契約は、
// Gemini API の切り離しに伴い外した。
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");


const taskNotesStart = source.indexOf("async function searchAgentTaskNotes");
const taskNotesEnd = source.indexOf("__name(searchAgentTaskNotes", taskNotesStart);
const taskNotesSource = source.slice(taskNotesStart, taskNotesEnd);
assert.ok(taskNotesStart >= 0 && taskNotesEnd > taskNotesStart, "searchAgentTaskNotes must exist");
assert.ok(taskNotesSource.includes('hasSensitiveCategory(wholeInspection.findings)'), "Background tasks must exclude sensitive notes from their context");


console.log("Agent organization contract checks passed.");
