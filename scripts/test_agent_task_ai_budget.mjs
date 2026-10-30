import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { reserveAgentAiBudget, settleAgentAiBudget, enqueueAgentTask, reserveQueuedAgentTaskBudget, requeueAgentTaskAfterBudgetWait, recordAgentTaskFailure, toSqliteDateTime } from "../src/background-task-store.mjs";

const root = new URL("../", import.meta.url);
const schema = await readFile(new URL("schema-snapshots/live-d1-schema-2026-10-19.sql", root), "utf8");
const taskMigration = await readFile(new URL("migrations/0011_agent_tasks.sql", root), "utf8");
const budgetMigration = await readFile(new URL("migrations/pending/0017_cloudflare_free_workflow_budget.sql", root), "utf8");

class D1Statement {
  constructor(sqlite, sql) { this.sqlite = sqlite; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  first() { return this.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  run() { const result = this.sqlite.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  batch(statements) {
    return this.sqlite.transaction(() => statements.map((statement) => {
      const result = this.sqlite.prepare(statement.sql).run(...statement.values);
      return { meta: { changes: Number(result.changes) } };
    }))();
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(schema);
sqlite.exec(taskMigration);
sqlite.exec(budgetMigration);
const db = new D1Database(sqlite);
const nowMs = Date.now();
const now = toSqliteDateTime(nowMs);
const future = toSqliteDateTime(nowMs + 60 * 60 * 1000);

sqlite.prepare(`
  INSERT INTO agent_tasks (task_id, task_type, status, lease_token, lease_expires_at, deadline_at, max_ai_tokens)
  VALUES ('settle-success', 'github_query', 'running', 'lease-a', ?, ?, 12000)
`).run(future, future);
assert.equal(await reserveAgentAiBudget(db, {
  taskId: "settle-success", leaseToken: "lease-a", estimatedTokens: 500, nowMs
}), true);
let row = sqlite.prepare("SELECT ai_calls_used, ai_tokens_used FROM agent_tasks WHERE task_id = 'settle-success'").get();
assert.deepEqual({ ...row }, { ai_calls_used: 1, ai_tokens_used: 500 });
assert.equal(await settleAgentAiBudget(db, {
  taskId: "settle-success", leaseToken: "lease-a", reservedTokens: 500, actualTokens: 140, nowMs
}), true);
row = sqlite.prepare("SELECT ai_calls_used, ai_tokens_used FROM agent_tasks WHERE task_id = 'settle-success'").get();
assert.deepEqual({ ...row }, { ai_calls_used: 1, ai_tokens_used: 140 });

sqlite.prepare(`
  INSERT INTO agent_tasks (task_id, task_type, status, lease_token, lease_expires_at, deadline_at, max_ai_tokens)
  VALUES ('settle-overrun', 'github_query', 'running', 'lease-b', ?, ?, 100)
`).run(future, future);
assert.equal(await reserveAgentAiBudget(db, {
  taskId: "settle-overrun", leaseToken: "lease-b", estimatedTokens: 400_000, nowMs
}), true);
assert.equal(await settleAgentAiBudget(db, {
  taskId: "settle-overrun", leaseToken: "lease-b", reservedTokens: 400_000, actualTokens: 600_000, nowMs
}), true);
row = sqlite.prepare("SELECT ai_calls_used, ai_tokens_used FROM agent_tasks WHERE task_id = 'settle-overrun'").get();
assert.deepEqual({ ...row }, { ai_calls_used: 1, ai_tokens_used: 600_000 });

const enqueueAt = Date.parse("2026-10-30T23:50:00.000Z");
const enqueueSql = toSqliteDateTime(enqueueAt);
sqlite.prepare(`
  INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at)
  VALUES ('2026-10-30', 84, 2700, ?)
`).run(enqueueSql);
const deferred = await enqueueAgentTask(db, {
  taskId: "queued-for-workflow-budget",
  taskType: "github_query",
  idempotencyKey: "queued-for-workflow-budget",
  payload: { prompt: "inspect repository" },
  maxTaskAgeMs: 8 * 60 * 60 * 1000,
  nowMs: enqueueAt,
});
assert.equal(deferred.queuedForBudget, true);
assert.equal(deferred.task.status, "queued");
assert.equal(deferred.task.budget_reserved, 0);
row = sqlite.prepare("SELECT next_attempt_at, deadline_at FROM agent_tasks WHERE task_id = 'queued-for-workflow-budget'").get();
assert.equal(row.next_attempt_at, "2026-10-31 00:01:00");
assert.equal(row.deadline_at, "2026-10-31 01:01:00");

const resumedAt = Date.parse("2026-10-31T00:02:00.000Z");
const reserved = await reserveQueuedAgentTaskBudget(db, { nowMs: resumedAt });
assert.equal(reserved.reserved, 1);
row = sqlite.prepare("SELECT status, budget_reserved, next_attempt_at FROM agent_tasks WHERE task_id = 'queued-for-workflow-budget'").get();
assert.deepEqual({ ...row }, { status: "queued", budget_reserved: 1, next_attempt_at: "2026-10-31 00:02:00" });
const budgetRow = sqlite.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = '2026-10-31'").get();
assert.deepEqual({ ...budgetRow }, { tasks_reserved: 1, workflow_steps_reserved: 32 });

const quotaAt = Date.parse("2026-10-31T12:00:00.000Z");
sqlite.prepare(`
  UPDATE agent_tasks
  SET status = 'running', lease_token = 'quota-lease',
      lease_expires_at = '2026-10-31 13:00:00',
      deadline_at = '2026-10-31 20:00:00',
      attempts = 1, started_at = '2026-10-31 00:02:00'
  WHERE task_id = 'queued-for-workflow-budget'
`).run();
const quotaFailure = await recordAgentTaskFailure(db, {
  taskId: "queued-for-workflow-budget",
  leaseToken: "quota-lease",
  errorClass: "workers_ai_daily_quota_exhausted",
  errorDetail: "Cloudflare Workers AI daily free allocation reached",
  retryable: true,
  nowMs: quotaAt,
});
assert.equal(quotaFailure.applied, true);
assert.equal(quotaFailure.decision.action, "retry");
assert.equal(quotaFailure.decision.retryAtMs, Date.parse("2026-11-01T00:01:00.000Z"));
row = sqlite.prepare("SELECT status, budget_reserved, attempts, last_error_class, next_attempt_at, deadline_at FROM agent_tasks WHERE task_id = 'queued-for-workflow-budget'").get();
assert.deepEqual({ ...row }, {
  status: "waiting",
  budget_reserved: 0,
  attempts: 0,
  last_error_class: "workers_ai_daily_quota_exhausted",
  next_attempt_at: "2026-11-01 00:01:00",
  deadline_at: "2026-11-01 01:01:00",
});
const quotaReservation = sqlite.prepare("SELECT budget_day, counted FROM agent_task_budget_reservations WHERE task_id = 'queued-for-workflow-budget'").get();
assert.deepEqual({ ...quotaReservation }, { budget_day: "2026-11-01", counted: 0 });
const nextDayReservation = await reserveQueuedAgentTaskBudget(db, {
  nowMs: Date.parse("2026-11-01T00:02:00.000Z"),
});
assert.equal(nextDayReservation.reserved, 1);
row = sqlite.prepare("SELECT status, budget_reserved, next_attempt_at FROM agent_tasks WHERE task_id = 'queued-for-workflow-budget'").get();
assert.deepEqual({ ...row }, { status: "waiting", budget_reserved: 1, next_attempt_at: "2026-11-01 00:02:00" });
const nextDayBudget = sqlite.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = '2026-11-01'").get();
assert.deepEqual({ ...nextDayBudget }, { tasks_reserved: 1, workflow_steps_reserved: 32 });

sqlite.prepare(`
  INSERT INTO agent_tasks (task_id, task_type, status, stop_reason, deadline_at, next_attempt_at, created_at, updated_at)
  VALUES ('legacy-budget-failure', 'github_query', 'failed', 'daily_workflow_budget_exhausted', ?, ?, ?, ?)
`).run("2026-10-30 23:59:00", "2026-10-30 23:59:00", "2026-10-30 23:50:00", "2026-10-30 23:50:00");
assert.equal(await requeueAgentTaskAfterBudgetWait(db, "legacy-budget-failure", Date.parse("2026-11-01T00:02:00.000Z")), true);
row = sqlite.prepare("SELECT status, budget_reserved, stop_reason FROM agent_tasks WHERE task_id = 'legacy-budget-failure'").get();
assert.deepEqual({ ...row }, { status: "queued", budget_reserved: 0, stop_reason: null });

sqlite.close();
console.log("Agent task AI token reservation settlement tests passed.");
