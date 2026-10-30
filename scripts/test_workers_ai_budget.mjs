import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  WORKERS_AI_FREE_DAILY_NEURONS,
  calculateWorkersAiNeurons,
  estimateWorkersAiInputTokens,
  estimateWorkersAiNeurons,
  reserveWorkersAiBudget,
  settleWorkersAiBudget,
  settleWorkersAiBudgetFailure,
} from "../src/workers-ai-budget.mjs";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
class D1Mock {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE workers_ai_daily_usage (
      usage_day TEXT PRIMARY KEY,
      reserved_neurons INTEGER NOT NULL DEFAULT 0 CHECK (reserved_neurons >= 0),
      actual_neurons INTEGER NOT NULL DEFAULT 0 CHECK (actual_neurons >= 0),
      calls_completed INTEGER NOT NULL DEFAULT 0 CHECK (calls_completed >= 0),
      calls_failed INTEGER NOT NULL DEFAULT 0 CHECK (calls_failed >= 0),
      updated_at TEXT NOT NULL
    )
  `);
  return { sqlite, db: new D1Mock(sqlite) };
}

test("input estimate is conservative for Japanese and English text", () => {
  assert.ok(estimateWorkersAiInputTokens("日本語の入力") > estimateWorkersAiInputTokens("hello"));
  assert.ok(estimateWorkersAiNeurons({
    model: "@cf/zai-org/glm-4.7-flash", prompt: "確認してください", maxOutputTokens: 1024
  }) > 0);
});

test("model usage converts prompt and completion tokens to Neurons", () => {
  assert.equal(calculateWorkersAiNeurons("@cf/zai-org/glm-4.7-flash", {
    prompt_tokens: 1_000_000, completion_tokens: 1_000_000
  }), 41_900);
  assert.equal(calculateWorkersAiNeurons("@cf/zai-org/glm-4.7-flash", {}), null);
});

test("daily Neurons reservations are telemetry only and never block provider calls", async () => {
  const { sqlite, db } = makeDb();
  const first = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "短い依頼", maxOutputTokens: 1024,
    nowMs: Date.parse("2026-10-30T08:59:00Z")
  });
  assert.equal(first.day, "2026-10-30");
  assert.equal(first.tracked, true);
  const before = sqlite.prepare("SELECT reserved_neurons FROM workers_ai_daily_usage").get();
  assert.equal(before.reserved_neurons, first.reservedNeurons);

  sqlite.prepare("UPDATE workers_ai_daily_usage SET actual_neurons = ?").run(WORKERS_AI_FREE_DAILY_NEURONS * 10);
  const second = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "次の依頼", maxOutputTokens: 1024,
    nowMs: Date.parse("2026-10-30T08:59:30Z")
  });
  assert.equal(second.tracked, true);
  assert.ok(second.reservedNeurons > 0);
  const after = sqlite.prepare("SELECT reserved_neurons, actual_neurons FROM workers_ai_daily_usage").get();
  assert.equal(after.reserved_neurons, before.reserved_neurons + second.reservedNeurons);
  assert.equal(after.actual_neurons, WORKERS_AI_FREE_DAILY_NEURONS * 10);
  sqlite.close();
});

test("missing telemetry schema never blocks a Workers AI request", async () => {
  const unavailableDb = { prepare() { throw new Error("no such table: workers_ai_daily_usage"); } };
  const reservation = await reserveWorkersAiBudget(unavailableDb, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "依頼", maxOutputTokens: 131072,
  });
  assert.equal(reservation.tracked, false);
  assert.deepEqual(await settleWorkersAiBudget(unavailableDb, reservation, {
    prompt_tokens: 10, completion_tokens: 10,
  }), { settled: false, reason: "usage_ledger_unavailable" });
  assert.deepEqual(await settleWorkersAiBudgetFailure(unavailableDb, reservation, 10), {
    settled: false, reason: "usage_ledger_unavailable",
  });
});

test("settlement replaces a reservation with measured usage and UTC day rolls over", async () => {
  const { sqlite, db } = makeDb();
  const reservation = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "test", maxOutputTokens: 128,
    nowMs: Date.parse("2026-10-30T23:59:59Z")
  });
  const result = await settleWorkersAiBudget(db, reservation, {
    prompt_tokens: 100, completion_tokens: 50
  }, Date.parse("2026-10-31T00:00:01Z"));
  assert.equal(result.settled, true);
  const row = sqlite.prepare("SELECT * FROM workers_ai_daily_usage WHERE usage_day = '2026-10-30'").get();
  assert.equal(row.reserved_neurons, 0);
  assert.equal(row.actual_neurons, calculateWorkersAiNeurons(reservation.model, {
    prompt_tokens: 100, completion_tokens: 50
  }));
  assert.equal(row.calls_completed, 1);
  const nextDay = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "next day", maxOutputTokens: 128,
    nowMs: Date.parse("2026-10-31T00:00:01Z")
  });
  assert.equal(nextDay.day, "2026-10-31");
  sqlite.close();
});

test("missing provider usage retains its reservation instead of undercounting", async () => {
  const { sqlite, db } = makeDb();
  const reservation = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "test", maxOutputTokens: 512
  });
  assert.deepEqual(await settleWorkersAiBudget(db, reservation, {}), {
    settled: false, reason: "usage_unavailable"
  });
  const row = sqlite.prepare("SELECT reserved_neurons, actual_neurons FROM workers_ai_daily_usage").get();
  assert.equal(row.reserved_neurons, reservation.reservedNeurons);
  assert.equal(row.actual_neurons, 0);
  sqlite.close();
});


test("a response-less provider failure settles estimated input only and releases output reservation", async () => {
  const { sqlite, db } = makeDb();
  const reservation = await reserveWorkersAiBudget(db, {
    model: "@cf/zai-org/glm-4.7-flash", prompt: "日本語の失敗した依頼", maxOutputTokens: 1024,
    nowMs: Date.parse("2026-10-30T12:00:00Z")
  });
  const inputTokens = estimateWorkersAiInputTokens("system prompt and user request");
  const settled = await settleWorkersAiBudgetFailure(db, reservation, inputTokens);
  assert.equal(settled.settled, true);
  assert.equal(settled.outcome, "failed");
  const row = sqlite.prepare("SELECT reserved_neurons, actual_neurons, calls_completed, calls_failed FROM workers_ai_daily_usage").get();
  assert.equal(row.reserved_neurons, 0);
  assert.equal(row.actual_neurons, calculateWorkersAiNeurons(reservation.model, {
    prompt_tokens: inputTokens, completion_tokens: 0
  }));
  assert.equal(row.calls_completed, 0);
  assert.equal(row.calls_failed, 1);
  sqlite.close();
});


test("unknown model pricing degrades telemetry only and never blocks inference", async () => {
  const { sqlite, db } = makeDb();
  const reservation = await reserveWorkersAiBudget(db, {
    model: "@cf/new-model/not-yet-priced",
    prompt: "依頼",
    maxOutputTokens: 2048,
  });
  assert.equal(reservation.tracked, false);
  assert.equal(reservation.reservedNeurons, 0);
  assert.deepEqual(await settleWorkersAiBudget(db, reservation, {
    prompt_tokens: 100, completion_tokens: 100,
  }), { settled: false, reason: "usage_ledger_unavailable" });
  assert.deepEqual(await settleWorkersAiBudgetFailure(db, reservation, 100), {
    settled: false, reason: "usage_ledger_unavailable",
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM workers_ai_daily_usage").get().count, 0);
  sqlite.close();
});
