import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  enqueueAgentMemoryJob,
  claimNextAgentMemoryJob,
  completeAgentMemoryJob,
  failAgentMemoryJob
} from "../src/agent-memory-queue.mjs";
import { inspectAndRedact, hasSensitiveCategory } from "../src/ai-send-guard.mjs";

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
// Stage / detail default to NULL when the caller does not provide them (Issue #63).
assert.equal(db.calls[1].params[4], null);
assert.equal(db.calls[1].params[5], null);

// Failure stage / detail (Issue #63): persisted alongside the error class so the
// latest attempt can be diagnosed from agent_memory_jobs alone.
db.calls.length = 0;
db.firstResult = { attempts: 1, max_attempts: 4 };
await failAgentMemoryJob(db, 7, {
  retryable: false, errorClass: "memory_processing_failed",
  errorStage: "save", errorDetail: "Error: SQLITE_CONSTRAINT_FOREIGNKEY constraint failed", nowMs
});
assert.match(db.calls[1].sql, /last_error_stage = \?/u);
assert.match(db.calls[1].sql, /last_error_detail = \?/u);
assert.equal(db.calls[1].params[0], "failed");
assert.equal(db.calls[1].params[3], "memory_processing_failed");
assert.equal(db.calls[1].params[4], "save");
assert.equal(db.calls[1].params[5], "Error: SQLITE_CONSTRAINT_FOREIGNKEY constraint failed");

// A retryable failure requeues and overwrites stage / detail with the latest attempt.
db.calls.length = 0;
db.firstResult = { attempts: 2, max_attempts: 4 };
await failAgentMemoryJob(db, 7, {
  retryable: true, errorClass: "gemini_server_error",
  errorStage: "extraction", errorDetail: "Error: Gemini returned 503", nowMs
});
assert.equal(db.calls[1].params[0], "queued");
assert.equal(db.calls[1].params[4], "extraction");
assert.equal(db.calls[1].params[5], "Error: Gemini returned 503");

// Stage is sanitized like the error class (code characters only, capped at 64) and
// the detail is capped at 200 characters before it is stored.
db.calls.length = 0;
db.firstResult = { attempts: 1, max_attempts: 4 };
await failAgentMemoryJob(db, 7, {
  retryable: false, errorClass: "memory_processing_failed",
  errorStage: "bad stage!; DROP", errorDetail: "x".repeat(250), nowMs
});
assert.equal(db.calls[1].params[4], "badstageDROP");
assert.equal(db.calls[1].params[5].length, 200);
await failAgentMemoryJob(db, 7, {
  retryable: false, errorClass: "memory_processing_failed",
  errorStage: "s".repeat(80), errorDetail: "", nowMs
});
assert.equal(db.calls[3].params[4], "s".repeat(64));
assert.equal(db.calls[3].params[5], null);

// Completion clears the recorded failure stage / detail along with the class.
db.calls.length = 0;
assert.equal(await completeAgentMemoryJob(db, 7, nowMs), true);
assert.match(db.calls[0].sql, /last_error_stage = NULL/u);
assert.match(db.calls[0].sql, /last_error_detail = NULL/u);

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

// AI-send boundary wiring (Issue #94; policy revised 2026-10-25 under Issue #61).
// History stores the inspected (redacted) text; credentials are masked and blocked, while
// sensitive-word matches no longer exclude a message from history, model input, or the
// memory-extraction queue. Runtime behaviour is covered by tests/ai-send-guard.test.js;
// this block only pins how the webhook wires it in.
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

// Failure stage / detail wiring (Issue #63): processAgentMemoryJob tracks the stage and
// annotates it onto a thrown error; drainAgentMemoryQueue persists stage + sanitized
// detail next to the unchanged retryable / errorClass decision, and adds the stage to
// the failure log line (stage is already an allowed extra field in log-sanitize).
assert.match(source, /errorStage: error\?\.memoryStage/u);
assert.match(source, /errorDetail: describeAgentTaskError\(error, env\)/u);
assert.match(source, /describeSafeFailure\("agent_memory_job_failed", error, \{ stage: error\?\.memoryStage \}\)/u);
for (const stageName of ["prepare", "search", "extraction", "save"]) {
  assert.match(source, new RegExp(`stage = "${stageName}"`, "u"));
}
assert.match(source, /error\.memoryStage = stage/u);

// The persisted detail is generated only by describeAgentTaskError. Evaluate the real
// function text from src/index.js with the real AI-send guard primitives and verify the
// hygiene contract: a normal failure keeps a short summary, while exception messages
// carrying credential-like values or personal data never reach the stored detail.
const detailStart = source.indexOf("function describeAgentTaskError(error, env) {");
assert.ok(detailStart > 0, "describeAgentTaskError not found");
const detailEnd = source.indexOf("\n}", detailStart);
assert.ok(detailEnd > detailStart, "describeAgentTaskError end not found");
const describeAgentTaskError = new Function(
  "inspectAndRedact", "hasSensitiveCategory",
  `${source.slice(detailStart, detailEnd + 2)}\nreturn describeAgentTaskError;`
)(inspectAndRedact, hasSensitiveCategory);

const plainDetail = describeAgentTaskError(new Error("Gemini returned no text"), {});
assert.equal(plainDetail, "Error: Gemini returned no text");
assert.ok(plainDetail.length <= 200);

const credentialDetail = describeAgentTaskError(
  new Error("upstream failed password=hunter2secret sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), {}
);
assert.equal(credentialDetail, "Error");
assert.ok(!credentialDetail.includes("hunter2secret"));
assert.ok(!credentialDetail.includes("sk-proj"));

const bearerDetail = describeAgentTaskError(
  new Error("request rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789"), {}
);
assert.equal(bearerDetail, "Error");

const fragmentDetail = describeAgentTaskError(
  new Error("save failed for note fragment; contact taro.example+test@gmail.com instead"), {}
);
assert.ok(!fragmentDetail.includes("taro.example+test@gmail.com"));
assert.ok(fragmentDetail.includes("[EMAIL]"));
assert.ok(fragmentDetail.length <= 200);

const longDetail = describeAgentTaskError(new Error("boom " + "y".repeat(500)), {});
assert.ok(longDetail.length <= 200);

console.log("Agent memory queue contracts passed.");
