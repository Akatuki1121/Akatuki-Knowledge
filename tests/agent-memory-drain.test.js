// Issue #86: src/agent-memory-drain.mjs のモジュール契約テスト。
// 記憶キューの drain (claim/完了/失敗分類) を index.js から分離したため、
// 文字列抽出ではなくモジュールの振る舞いで検証する。drain の失敗分類は
// キューの再試行動作そのものであり、2026-10-25 夜の job 25
// (memory_processing_failed、attempts 1/4 で終端) が実測ケース。
// 再試行ポリシーは抽出前と同一であることをここで固定する。
// D1 はインメモリフェイクで agent_memory_jobs に対する queue 群
// (src/agent-memory-queue.mjs) の SQL 意味論を再現する。queue 関数は実物を
// 使い、処理本体 processAgentMemoryJob だけをスタブで注入する。
// 実装は Date.now() を直接使うため、フィクスチャは現在時刻前後で組む
// (時計注入のリファクタはこの抽出には混ぜない)。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAgentMemoryDrain } from "../src/agent-memory-drain.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./agent-memory-drain.mjs"'), "the Worker entry point must import the agent memory drain module");
assert.ok(workerSource.includes("createAgentMemoryDrain({ processAgentMemoryJob })"), "the Worker entry point must build the drain through the factory with the job processor injected");
assert.ok(!workerSource.includes("async function drainAgentMemoryQueue"), "drainAgentMemoryQueue must no longer be defined in the Worker entry point");
assert.ok(workerSource.includes("ctx.waitUntil(drainAgentMemoryQueue(env, 1))"), "the webhook must keep draining the memory queue through the moved function");

const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();

// agent_memory_jobs テーブルのインメモリフェイク。prepare される SQL の意味論
// だけを再現し、実行された文と bind を記録する。failOn に文の断片を入れると
// その文で例外を投げる。
function createFakeDb({ failOn = null } = {}) {
  const rows = new Map();
  const calls = [];
  const matches = (sql) => failOn && sql.includes(failOn);
  function prepare(sql) {
    return {
      bind(...args) {
        calls.push({ sql, args });
        return {
          async run() {
            if (matches(sql)) throw new Error("fake D1 failure");
            const now = new Date().toISOString();
            if (sql.includes("attempt_budget_exhausted")) {
              // claim 前の掃引: 試行上限に達した queued / リース切れ processing を終端する。
              let changes = 0;
              for (const row of rows.values()) {
                if ((row.status === "queued" || row.status === "processing")
                  && row.attempts >= row.max_attempts
                  && (row.status === "queued" || !row.lease_expires_at || row.lease_expires_at <= now)) {
                  row.status = "failed";
                  row.last_error_class = "attempt_budget_exhausted";
                  row.lease_expires_at = null;
                  row.message_text = "";
                  row.completed_at = now;
                  row.updated_at = now;
                  changes += 1;
                }
              }
              return { meta: { changes } };
            }
            if (sql.includes("SET status = 'completed'")) {
              const [completedAt, updatedAt, jobId] = args;
              const row = rows.get(jobId);
              if (!row || row.status !== "processing") return { meta: { changes: 0 } };
              row.status = "completed";
              row.message_text = "";
              row.lease_expires_at = null;
              row.last_error_class = null;
              row.completed_at = completedAt;
              row.updated_at = updatedAt;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = ?, next_attempt_at = ?")) {
              const [status, nextAttemptAt, , errorClass, , completedAt, updatedAt, jobId] = args;
              const row = rows.get(jobId);
              if (!row || row.status !== "processing") return { meta: { changes: 0 } };
              row.status = status;
              row.next_attempt_at = nextAttemptAt;
              row.lease_expires_at = null;
              if (status === "failed") row.message_text = "";
              row.last_error_class = errorClass;
              row.completed_at = status === "failed" ? completedAt : null;
              row.updated_at = updatedAt;
              return { meta: { changes: 1 } };
            }
            throw new Error(`unexpected SQL in fake D1 run(): ${sql.slice(0, 80)}`);
          },
          async first() {
            if (matches(sql)) throw new Error("fake D1 failure");
            const now = new Date().toISOString();
            if (sql.includes("RETURNING job_id")) {
              // claim: 有効なリースを持つ processing があれば新規 claim しない。
              const active = [...rows.values()].some(
                (row) => row.status === "processing" && row.lease_expires_at && row.lease_expires_at > now
              );
              if (active) return null;
              const candidate = [...rows.values()]
                .filter((row) => row.attempts < row.max_attempts
                  && ((row.status === "queued" && row.next_attempt_at <= now)
                    || (row.status === "processing" && (!row.lease_expires_at || row.lease_expires_at <= now))))
                .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.job_id - b.job_id))[0];
              if (!candidate) return null;
              candidate.status = "processing";
              candidate.attempts += 1;
              candidate.lease_expires_at = new Date(Date.now() + 120_000).toISOString();
              candidate.updated_at = now;
              return {
                job_id: candidate.job_id, chat_id: candidate.chat_id, message_id: candidate.message_id,
                message_text: candidate.message_text, attempts: candidate.attempts,
                max_attempts: candidate.max_attempts, created_at: candidate.created_at
              };
            }
            if (sql.includes("SELECT attempts, max_attempts")) {
              const [jobId] = args;
              const row = rows.get(jobId);
              if (!row || row.status !== "processing") return null;
              return { attempts: row.attempts, max_attempts: row.max_attempts };
            }
            throw new Error(`unexpected SQL in fake D1 first(): ${sql.slice(0, 80)}`);
          }
        };
      }
    };
  }
  return { DB: { prepare }, rows, calls };
}

let nextJobId = 1;
function seedJob(rows, overrides = {}) {
  const jobId = nextJobId;
  nextJobId += 1;
  const row = {
    job_id: jobId, chat_id: "123", message_id: `m${jobId}`,
    message_text: "短い返答が好き、と覚えておいて", status: "queued", attempts: 0, max_attempts: 4,
    next_attempt_at: past(), lease_expires_at: null, last_error_class: null,
    created_at: past(600_000 - jobId * 1000), updated_at: past(), completed_at: null,
    ...overrides
  };
  rows.set(row.job_id, row);
  return row;
}

function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  return { lines, restore: () => { console.error = original; } };
}

function httpError(status) {
  const error = new Error(`upstream ${status}`);
  error.httpStatus = status;
  return error;
}

function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

const okProcessor = (record) => async (env, job) => { record.push(job.job_id); };
const failingProcessor = (error) => async () => { throw error; };

test("drain: env.DB がなければ no-op で処理本体を呼ばない", async () => {
  const processed = [];
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
  await drainAgentMemoryQueue({}, 1);
  await drainAgentMemoryQueue({ GEMINI_API_KEY: "key" }, 1);
  await drainAgentMemoryQueue(undefined, 1);
  assert.deepEqual(processed, []);
});

test("drain: GEMINI_API_KEY がなければ claim 自体を試みない", async () => {
  const fake = createFakeDb();
  seedJob(fake.rows);
  const processed = [];
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
  await drainAgentMemoryQueue({ DB: fake.DB }, 1);
  assert.deepEqual(processed, []);
  assert.equal(fake.calls.length, 0);
});

test("drain: limit は 1–2 にクランプされる (未指定/0 は 1、3 以上は 2)", async () => {
  {
    const fake = createFakeDb();
    seedJob(fake.rows); seedJob(fake.rows); seedJob(fake.rows);
    const processed = [];
    const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" });
    assert.equal(processed.length, 1);
  }
  {
    const fake = createFakeDb();
    seedJob(fake.rows); seedJob(fake.rows); seedJob(fake.rows);
    const processed = [];
    const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 0);
    assert.equal(processed.length, 1);
  }
  {
    const fake = createFakeDb();
    seedJob(fake.rows); seedJob(fake.rows); seedJob(fake.rows);
    const processed = [];
    const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 99);
    assert.equal(processed.length, 2);
    assert.equal([...fake.rows.values()].filter((row) => row.status === "queued").length, 1);
  }
});

test("drain: 正常系は claim したジョブを completed にし本文を消去する", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows);
  const seen = [];
  const env = { DB: fake.DB, GEMINI_API_KEY: "key" };
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({
    processAgentMemoryJob: async (envArg, job) => { seen.push({ envArg, job }); }
  });
  await drainAgentMemoryQueue(env, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].envArg, env);
  assert.equal(seen[0].job.job_id, row.job_id);
  assert.equal(row.status, "completed");
  assert.equal(row.message_text, "");
  assert.equal(row.last_error_class, null);
  assert.ok(row.completed_at);
  assert.equal(row.attempts, 1);
});

test("drain: キューが空なら何もしない", async () => {
  const fake = createFakeDb();
  const processed = [];
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
  await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 2);
  assert.deepEqual(processed, []);
});

test("drain: HTTP 429 は gemini_limit として再試行可能に queued へ戻す", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows);
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: failingProcessor(httpError(429)) });
  const captured = captureConsoleError();
  const before = Date.now();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.status, "queued");
  assert.equal(row.last_error_class, "gemini_limit");
  assert.equal(row.message_text, "短い返答が好き、と覚えておいて");
  assert.equal(row.completed_at, null);
  const retryInMs = Date.parse(row.next_attempt_at) - before;
  assert.ok(retryInMs > 20_000 && retryInMs <= 35_000, `初回バックオフは約30秒 (実測 ${retryInMs}ms)`);
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "agent memory job failed");
  assert.ok(String(captured.lines[0][1]).includes("agent_memory_job_failed"));
});

test("drain: HTTP 5xx は gemini_server_error として再試行可能に queued へ戻す", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows);
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: failingProcessor(httpError(503)) });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.status, "queued");
  assert.equal(row.last_error_class, "gemini_server_error");
});

test("drain: TimeoutError / AbortError は timeout として再試行可能に queued へ戻す", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const fake = createFakeDb();
    const row = seedJob(fake.rows);
    const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: failingProcessor(namedError(name)) });
    const captured = captureConsoleError();
    try {
      await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
    } finally {
      captured.restore();
    }
    assert.equal(row.status, "queued", name);
    assert.equal(row.last_error_class, "timeout", name);
  }
});

test("drain: TypeError は network_error として再試行可能に queued へ戻す", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows);
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({
    processAgentMemoryJob: failingProcessor(new TypeError("fetch failed"))
  });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.status, "queued");
  assert.equal(row.last_error_class, "network_error");
});

test("drain: 一般の Error は memory_processing_failed として attempts 1/4 のまま終端する (job 25 の実測ケース)", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows);
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({
    processAgentMemoryJob: failingProcessor(new Error("extraction blew up"))
  });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.status, "failed");
  assert.equal(row.last_error_class, "memory_processing_failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.max_attempts, 4);
  assert.equal(row.message_text, "");
  assert.ok(row.completed_at);
});

test("drain: attempts が上限に達した試行では、再試行可能クラスでも終端する", async () => {
  const fake = createFakeDb();
  const row = seedJob(fake.rows, { attempts: 3 });
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: failingProcessor(httpError(429)) });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.attempts, 4);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error_class, "gemini_limit");
  assert.equal(row.message_text, "");
});

test("drain: claim 自体の失敗では安全化ログを出して打ち切り、外へ投げない", async () => {
  const fake = createFakeDb({ failOn: "attempt_budget_exhausted" });
  seedJob(fake.rows);
  const processed = [];
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.deepEqual(processed, []);
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "agent memory queue claim failed");
  assert.ok(String(captured.lines[0][1]).includes("agent_memory_queue_claim_failed"));
});

test("drain: 失敗状態の更新が失敗しても例外を外へ投げず、安全化ログで打ち切る", async () => {
  const fake = createFakeDb({ failOn: "SET status = ?, next_attempt_at = ?" });
  const row = seedJob(fake.rows);
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({
    processAgentMemoryJob: failingProcessor(new Error("extraction blew up"))
  });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.equal(row.status, "processing");
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0][0], "agent memory job state update failed");
  assert.ok(String(captured.lines[0][1]).includes("agent_memory_job_state_update_failed"));
});

test("drain: 完了記録の失敗も同じ catch で分類され、一般エラーなら終端失敗になる", async () => {
  const fake = createFakeDb({ failOn: "SET status = 'completed'" });
  const row = seedJob(fake.rows);
  const processed = [];
  const { drainAgentMemoryQueue } = createAgentMemoryDrain({ processAgentMemoryJob: okProcessor(processed) });
  const captured = captureConsoleError();
  try {
    await drainAgentMemoryQueue({ DB: fake.DB, GEMINI_API_KEY: "key" }, 1);
  } finally {
    captured.restore();
  }
  assert.deepEqual(processed, [row.job_id]);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error_class, "memory_processing_failed");
});
