import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  enqueueAgentMemoryJob,
  claimNextAgentMemoryJob,
  completeAgentMemoryJob,
  failAgentMemoryJob
} from "../src/agent-memory-queue.mjs";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async run() {
    this.db.calls.push({ method: "run", sql: this.sql, params: this.params });
    return { meta: { changes: this.db.changes } };
  }
  async first() {
    this.db.calls.push({ method: "first", sql: this.sql, params: this.params });
    return this.db.firstResult;
  }
}
class Database {
  constructor() { this.calls = []; this.changes = 1; this.firstResult = null; }
  prepare(sql) { return new Statement(this, sql); }
}

const nowMs = Date.parse("2026-10-23T00:00:00.000Z");
const db = new Database();
const queued = await enqueueAgentMemoryJob(db, {
  chatId: "123",
  messageId: "456",
  messageText: "私は短い返答が好きです。",
  nowMs
});
assert.deepEqual(queued, { inserted: true });
assert.match(db.calls[0].sql, /INSERT OR IGNORE INTO agent_memory_jobs/u);
assert.match(db.calls[0].sql, /agent_memory_jobs/u);
assert.equal(db.calls[0].params[0], "123");
assert.equal(db.calls[0].params[1], "456");
assert.equal(db.calls[0].params[2], "私は短い返答が好きです。");
assert.equal(db.calls[0].params[3], 4);

await assert.rejects(
  enqueueAgentMemoryJob(db, { chatId: "123", messageId: "456", messageText: "" }),
  /Invalid agent memory job/u
);
await assert.rejects(
  enqueueAgentMemoryJob(db, { chatId: "123", messageId: "456", messageText: "x".repeat(50001) }),
  /Invalid agent memory job/u
);

db.calls.length = 0;
db.firstResult = {
  job_id: 7, chat_id: "123", message_id: "456",
  message_text: "私は短い返答が好きです。", attempts: 1, max_attempts: 4
};
const claimed = await claimNextAgentMemoryJob(db, { nowMs });
assert.equal(claimed.job_id, 7);
assert.match(db.calls[0].sql, /attempts >= max_attempts/u);
assert.match(db.calls[1].sql, /RETURNING job_id, chat_id, message_id, message_text, attempts, max_attempts, created_at/u);
assert.match(db.calls[1].sql, /lease_expires_at IS NULL OR lease_expires_at <=/u);
assert.match(db.calls[1].sql, /active.status = 'processing'/u);
assert.equal(db.calls[1].params.length, 8);
assert.equal(db.calls[1].params[0], new Date(nowMs + 120000).toISOString());

db.calls.length = 0;
assert.equal(await completeAgentMemoryJob(db, 7, nowMs), true);
assert.match(db.calls[0].sql, /status = 'completed'/u);
assert.match(db.calls[0].sql, /message_text = ''/u);
assert.equal(db.calls[0].params[2], 7);
await assert.rejects(completeAgentMemoryJob(db, 0, nowMs), /Invalid agent memory job ID/u);

db.calls.length = 0;
db.firstResult = { attempts: 2, max_attempts: 4 };
assert.equal(await failAgentMemoryJob(db, 7, { retryable: true, errorClass: "gemini_limit", nowMs }), true);
assert.equal(db.calls[0].method, "first");
assert.equal(db.calls[1].params[0], "queued");
assert.equal(db.calls[1].params[1], new Date(nowMs + 60000).toISOString());
assert.equal(db.calls[1].params[2], "queued");
assert.equal(db.calls[1].params[3], "gemini_limit");

db.calls.length = 0;
db.firstResult = { attempts: 4, max_attempts: 4 };
await failAgentMemoryJob(db, 7, { retryable: true, errorClass: "bad status!", nowMs });
assert.equal(db.calls[1].params[0], "failed");
assert.equal(db.calls[1].params[2], "failed");
assert.equal(db.calls[1].params[3], "badstatus");

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.match(source, /enqueueAgentMemoryJob\(env\.DB/u);
assert.match(source, /ctx\.waitUntil\(drainAgentMemoryQueue\(env, 1\)\)/u);
assert.match(source, /event: "telegram_answer_timing"/u);
assert.match(source, /event: "agent_memory_timing"/u);
assert.match(source, /searchMs, generationMs/u);
const answerStart = source.indexOf("async function answerTelegramMessage");
const answerEnd = source.indexOf('__name(answerTelegramMessage', answerStart);
const answerBody = source.slice(answerStart, answerEnd);
assert.doesNotMatch(answerBody, /await applyTelegramCapture/u);
assert.doesNotMatch(answerBody, /enqueueAgentMemoryJob/u);
assert.doesNotMatch(answerBody, /memoryQueuePromise/u);
assert.doesNotMatch(answerBody, /memoryQueueMs/u);
assert.doesNotMatch(answerBody, /parsed\.improvement/u);
assert.match(source, /async function processAgentMemoryJob/u);

// Sensitive-category boundary (Issue #94, decided under Issue #61). The original text of
// health/financial/location messages is kept in Telegram history; credentials are still masked.
// Sensitive text is excluded where it is sent to the model (selectAiSafeHistory and callGemini),
// and sensitive messages are never queued for AI memory extraction. Runtime behaviour is covered
// by tests/ai-send-guard.test.js; this block only pins how the webhook wires it in.
const hookStart = source.indexOf("const historyPlan = planTelegramHistory(text2");
const hookEnd = source.indexOf("let processingMessageId", hookStart);
assert.ok(hookStart > 0 && hookEnd > hookStart, "Telegram webhook history/queue block not found");
const hook = source.slice(hookStart, hookEnd);
assert.doesNotMatch(source, /\[SENSITIVE_INFO_REDACTED\]/u);
assert.match(hook, /const safeHistoryText = historyPlan\.historyText/u);
const historyInsert = hook.match(/INSERT OR IGNORE INTO telegram_messages[^\n]*\.bind\(([^)]*)\)/u);
assert.ok(historyInsert, "telegram_messages insert not found");
assert.match(historyInsert[1], /\bsafeHistoryText\b/u);
assert.doesNotMatch(historyInsert[1], /\btext2\b/u);
const enqueueGuard = hook.match(/if \(([^{]*)\) \{\s*await enqueueAgentMemoryJob\(env\.DB, \{([^}]*)\}/u);
assert.ok(enqueueGuard, "memory job enqueue block not found");
assert.match(enqueueGuard[1], /historyPlan\.queueMemory/u);
assert.match(enqueueGuard[2], /messageText: safeHistoryText/u);
assert.doesNotMatch(enqueueGuard[2], /\btext2\b/u);
assert.equal((hook.match(/enqueueAgentMemoryJob\(/gu) || []).length, 1);
// Every conversation-history prompt block goes through the same AI-send boundary helper.
assert.equal((source.match(/selectAiSafeHistory\(/gu) || []).length, 2);

console.log("Agent memory queue contracts passed.");
