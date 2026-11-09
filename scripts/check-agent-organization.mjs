import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// 背景タスクのコンテキスト検索 (searchAgentTaskNotes) の契約。
// Telegram チャット対話 (一括 AI 送信許可・フォルダ整理・会話要約・/save) の
// 契約は、ボット廃止に伴いこのチェックからも外した。
// /api/ai-preview・自動整理 (organize.mjs)・Gemini 境界の契約は、
// Gemini API の切り離しに伴い外した。
// 2026-11-09 の所有者決定で、残っていた ai_allowed ゲートと本文全体の
// 認証情報スキャンによる除外も撤去した (Gemini 時代の残骸)。背景タスクは
// ノートを ai_allowed や本文スキャンで除外せず、タイトルと抜粋への
// 送信直前の伏字だけを適用する。このチェックは撤去の維持を担う。
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");


const taskNotesStart = source.indexOf("async function searchAgentTaskNotes");
const taskNotesEnd = source.indexOf("__name(searchAgentTaskNotes", taskNotesStart);
const taskNotesSource = source.slice(taskNotesStart, taskNotesEnd);
assert.ok(taskNotesStart >= 0 && taskNotesEnd > taskNotesStart, "searchAgentTaskNotes must exist");
assert.ok(!taskNotesSource.includes("note.ai_allowed"), "Background tasks must not gate notes by ai_allowed");
assert.ok(!taskNotesSource.includes("inspectWholeContent"), "Background tasks must not rescan whole note content");
assert.ok(taskNotesSource.includes("inspectAndRedact(note.title"), "Background tasks must still redact titles before sending");
assert.ok(taskNotesSource.includes("inspectAndRedact(excerpt(note.content"), "Background tasks must still redact excerpts before sending");


console.log("Agent organization contract checks passed.");
