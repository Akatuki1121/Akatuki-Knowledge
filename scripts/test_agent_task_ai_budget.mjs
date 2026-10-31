import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { reserveAgentAiBudget, settleAgentAiBudget, enqueueAgentTask, reserveQueuedAgentTaskBudget, requeueAgentTaskAfterBudgetWait, recordAgentTaskFailure, reassessImprovementAgentTask, toSqliteDateTime } from "../src/background-task-store.mjs";

const root = new URL("../", import.meta.url);
const schema = await readFile(new URL("schema-snapshots/live-d1-schema-2026-10-19.sql", root), "utf8");
const taskMigration = await readFile(new URL("migrations/0011_agent_tasks.sql", root), "utf8");
const budgetMigration = await readFile(new URL("migrations/0017_cloudflare_free_workflow_budget.sql", root), "utf8");
const attentionMigration = await readFile(new URL("migrations/0019_agent_task_attention_and_reassessment.sql", root), "utf8");

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
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = this.sqlite.prepare(statement.sql).run(...statement.values);
        return { meta: { changes: Number(result.changes) } };
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(schema);
sqlite.exec(taskMigration);
sqlite.exec(budgetMigration);
sqlite.exec(attentionMigration);
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
assert.equal(row.deadline_at, "2026-10-31 07:50:00");

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
assert.equal(quotaFailure.workflowBudgetReleased, true);
assert.equal(quotaFailure.decision.action, "retry");
assert.equal(quotaFailure.decision.retryAtMs, Date.parse("2026-11-01T00:01:00.000Z"));
row = sqlite.prepare("SELECT status, budget_reserved, attempts, last_error_class, next_attempt_at, deadline_at FROM agent_tasks WHERE task_id = 'queued-for-workflow-budget'").get();
assert.deepEqual({ ...row }, {
  status: "waiting",
  budget_reserved: 0,
  attempts: 1,
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
sqlite.prepare("INSERT INTO agent_tasks (task_id, task_type, status, budget_reserved, payload_json, attempts, lease_token, lease_expires_at, deadline_at, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("cross-day-retry", "github_query", "running", 1, JSON.stringify({ prompt: "retry" }), 1,
    "cross-day-lease", "2026-11-01 00:10:00", "2026-11-01 00:30:00",
    "2026-10-31 23:59:50", "2026-10-31 23:50:00", "2026-10-31 23:59:50");
sqlite.prepare("INSERT INTO agent_task_budget_reservations (task_id, budget_day, workflow_steps, counted) VALUES (?, ?, ?, ?)")
  .run("cross-day-retry", "2026-10-31", 32, 2);
sqlite.prepare("UPDATE agent_task_daily_budget SET tasks_reserved = tasks_reserved + 1, workflow_steps_reserved = workflow_steps_reserved + 32 WHERE budget_day = ?")
  .run("2026-10-31");
const crossDayFailure = await recordAgentTaskFailure(db, {
  taskId: "cross-day-retry",
  leaseToken: "cross-day-lease",
  errorClass: "timeout",
  errorDetail: "timeout",
  retryable: true,
  nowMs: Date.parse("2026-10-31T23:59:50.000Z"),
});
assert.equal(crossDayFailure.applied, true);
assert.equal(crossDayFailure.workflowBudgetReleased, true);
assert.equal(new Date(crossDayFailure.decision.retryAtMs).toISOString().slice(0, 10), "2026-11-01");
row = sqlite.prepare("SELECT status, budget_reserved FROM agent_tasks WHERE task_id = 'cross-day-retry'").get();
assert.deepEqual({ ...row }, { status: "waiting", budget_reserved: 0 });
const crossDayReservation = sqlite.prepare("SELECT budget_day, counted FROM agent_task_budget_reservations WHERE task_id = 'cross-day-retry'").get();
assert.deepEqual({ ...crossDayReservation }, { budget_day: "2026-11-01", counted: 0 });
const crossDayReserved = await reserveQueuedAgentTaskBudget(db, { nowMs: Date.parse("2026-11-01T00:03:00.000Z") });
assert.equal(crossDayReserved.reserved, 1);
row = sqlite.prepare("SELECT status, budget_reserved FROM agent_tasks WHERE task_id = 'cross-day-retry'").get();
assert.deepEqual({ ...row }, { status: "waiting", budget_reserved: 1 });

const nextDayBudget = sqlite.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = '2026-11-01'").get();
assert.deepEqual({ ...nextDayBudget }, { tasks_reserved: 2, workflow_steps_reserved: 64 });

sqlite.prepare(`
  INSERT INTO agent_tasks (task_id, task_type, status, stop_reason, deadline_at, next_attempt_at, created_at, updated_at)
  VALUES ('legacy-budget-failure', 'github_query', 'failed', 'daily_workflow_budget_exhausted', ?, ?, ?, ?)
`).run("2026-10-30 23:59:00", "2026-10-30 23:59:00", "2026-10-30 23:50:00", "2026-10-30 23:50:00");
assert.equal(await requeueAgentTaskAfterBudgetWait(db, "legacy-budget-failure", Date.parse("2026-11-01T00:02:00.000Z")), true);
row = sqlite.prepare("SELECT status, budget_reserved, stop_reason FROM agent_tasks WHERE task_id = 'legacy-budget-failure'").get();
assert.deepEqual({ ...row }, { status: "queued", budget_reserved: 0, stop_reason: null });


const staleAt = Date.parse("2026-10-31T14:00:00.000Z");
const staleExpiry = toSqliteDateTime(staleAt - 60_000);
const staleDeadline = toSqliteDateTime(staleAt + 60 * 60 * 1000);
// Every AI reservation also renews a still-valid lease, so multiple model
// calls cannot consume the original 120-second lease without refreshing it.
sqlite.prepare(`
  INSERT INTO agent_tasks (
    task_id, task_type, status, lease_token, lease_expires_at, deadline_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "renew-on-ai-reservation", "github_query", "running", "renew-token",
  toSqliteDateTime(staleAt + 5_000), staleDeadline, staleExpiry, staleExpiry,
);
assert.equal(await reserveAgentAiBudget(db, {
  taskId: "renew-on-ai-reservation", leaseToken: "renew-token", estimatedTokens: 100, nowMs: staleAt
}), true);
row = sqlite.prepare("SELECT lease_expires_at FROM agent_tasks WHERE task_id = 'renew-on-ai-reservation'").get();
assert.equal(row.lease_expires_at, toSqliteDateTime(staleAt + 120_000));

// A late-starting call may still reserve against its original token when
// no replacement workflow has claimed the expired lease.
sqlite.prepare(`
  INSERT INTO agent_tasks (
    task_id, task_type, status, lease_token, lease_expires_at, deadline_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "reserve-after-expiry", "github_query", "running", "late-reserve-token",
  staleExpiry, staleDeadline, staleExpiry, staleExpiry,
);
assert.equal(await reserveAgentAiBudget(db, {
  taskId: "reserve-after-expiry", leaseToken: "late-reserve-token", estimatedTokens: 250, nowMs: staleAt
}), true);
row = sqlite.prepare("SELECT ai_tokens_used, lease_expires_at FROM agent_tasks WHERE task_id = 'reserve-after-expiry'").get();
assert.deepEqual({ ...row }, {
  ai_tokens_used: 250,
  lease_expires_at: toSqliteDateTime(staleAt + 120_000),
});

// Expired leases must not discard provider settlement or the final failure.
// The lease token is the fencing value: expiry alone does not mean a new
// workflow has claimed the task.
sqlite.prepare(`
  INSERT INTO agent_tasks (
    task_id, task_type, status, payload_json, attempts, max_attempts,
    ai_calls_used, ai_tokens_used, lease_token, lease_expires_at,
    deadline_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "expired-lease-failure", "github_query", "running",
  JSON.stringify({ improvementRequest: true }), 4, 4, 1, 136_757,
  "expired-lease-token", staleExpiry, staleDeadline, staleExpiry, staleExpiry,
);
assert.equal(await settleAgentAiBudget(db, {
  taskId: "expired-lease-failure",
  leaseToken: "expired-lease-token",
  reservedTokens: 136_757,
  actualTokens: 5_685,
  nowMs: staleAt,
}), true);
row = sqlite.prepare("SELECT ai_tokens_used FROM agent_tasks WHERE task_id = 'expired-lease-failure'").get();
assert.equal(row.ai_tokens_used, 5_685);
const staleFailure = await recordAgentTaskFailure(db, {
  taskId: "expired-lease-failure",
  leaseToken: "expired-lease-token",
  errorClass: "upstream_5xx",
  errorDetail: "WorkersAiError: upstream HTTP 503",
  retryable: true,
  nowMs: staleAt,
});
assert.equal(staleFailure.applied, true);
assert.equal(staleFailure.decision.stopReason, "attempt_budget_exhausted");
row = sqlite.prepare("SELECT status, last_error_class, last_error, stop_reason FROM agent_tasks WHERE task_id = 'expired-lease-failure'").get();
assert.deepEqual({ ...row }, {
  status: "needs_attention",
  last_error_class: "upstream_5xx",
  last_error: "WorkersAiError: upstream HTTP 503",
  stop_reason: "attempt_budget_exhausted",
});


const legacyFailureAt = Date.parse("2026-10-31T15:00:00.000Z");
sqlite.prepare(`
  INSERT INTO agent_tasks (
    task_id, task_type, status, budget_reserved, payload_json, attempts, max_attempts,
    created_at, updated_at, deadline_at, next_attempt_at,
    last_error_class, last_error, stop_reason, retry_policy_version
  ) VALUES (?, 'github_query', 'failed', 1, ?, 1, 1,
    '2026-10-29 18:01:04', '2026-10-29 18:01:04', '2026-10-29 19:01:04',
    '2026-10-29 19:01:04', 'unknown', 'Error: workers_ai_request_failed',
    'attempt_budget_exhausted', 0)
`).run("observed-attempt-budget-exhausted", JSON.stringify({
  prompt: "re-evaluate the same improvement request",
  improvementRequest: true,
  improvementNotePath: "Notes/改善/状態集約.md",
  sourceSyncUuid: "9eaaeb6a-19b1-4b4e-bfb5-4a6b4c8c44d1"
}));
const legacyReassessment = await reassessImprovementAgentTask(db, "observed-attempt-budget-exhausted", {
  nowMs: legacyFailureAt,
  policyVersion: 1,
  retryable: true,
  errorClass: "workers_ai_transient_failure",
});
assert.equal(legacyReassessment.reassessed, true);
assert.equal(legacyReassessment.status, "waiting");
assert.equal(legacyReassessment.attempts, 1, "Reassessment must not reset cumulative attempts");
assert.equal(legacyReassessment.max_attempts, 4, "Legacy one-attempt rows receive the bounded four-attempt policy");
row = sqlite.prepare("SELECT status, attempts, max_attempts, retry_policy_version, last_error_class, last_error, deadline_at FROM agent_tasks WHERE task_id = 'observed-attempt-budget-exhausted'").get();
assert.deepEqual({ ...row }, {
  status: "waiting",
  attempts: 1,
  max_attempts: 4,
  retry_policy_version: 1,
  last_error_class: "workers_ai_transient_failure",
  last_error: "Error: workers_ai_request_failed",
  deadline_at: toSqliteDateTime(legacyFailureAt + 8 * 60 * 60 * 1000),
});
const repeatedReassessment = await reassessImprovementAgentTask(db, "observed-attempt-budget-exhausted", {
  nowMs: legacyFailureAt + 60_000,
  policyVersion: 1,
  retryable: true,
  errorClass: "workers_ai_transient_failure",
});
assert.equal(repeatedReassessment.reassessed, false, "Hourly inbox scans must not restart the same task repeatedly");
row = sqlite.prepare("SELECT attempts, max_attempts, deadline_at FROM agent_tasks WHERE task_id = 'observed-attempt-budget-exhausted'").get();
assert.deepEqual({ ...row }, {
  attempts: 1,
  max_attempts: 4,
  deadline_at: toSqliteDateTime(legacyFailureAt + 8 * 60 * 60 * 1000),
});

sqlite.prepare("UPDATE agent_tasks SET status = 'running', attempts = 2, lease_token = 'legacy-retry-2', lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
  .run(toSqliteDateTime(legacyFailureAt + 120_000), toSqliteDateTime(legacyFailureAt + 60_000), "observed-attempt-budget-exhausted");
const legacyRetryFailure = await recordAgentTaskFailure(db, {
  taskId: "observed-attempt-budget-exhausted",
  leaseToken: "legacy-retry-2",
  errorClass: "workers_ai_transient_failure",
  errorDetail: "workers_ai_request_failed",
  retryable: true,
  nowMs: legacyFailureAt + 60_000,
});
assert.equal(legacyRetryFailure.applied, true);
assert.equal(legacyRetryFailure.decision.action, "retry");
assert.equal(legacyRetryFailure.decision.delayMs, 3 * 60 * 60 * 1000);
row = sqlite.prepare("SELECT status, attempts, max_attempts FROM agent_tasks WHERE task_id = 'observed-attempt-budget-exhausted'").get();
assert.deepEqual({ ...row }, { status: "waiting", attempts: 2, max_attempts: 4 });

sqlite.prepare("UPDATE agent_tasks SET status = 'running', attempts = 4, lease_token = 'legacy-retry-4', lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
  .run(toSqliteDateTime(legacyFailureAt + 4 * 60 * 60 * 1000), toSqliteDateTime(legacyFailureAt + 3 * 60 * 60 * 1000), "observed-attempt-budget-exhausted");
const exhaustedImprovement = await recordAgentTaskFailure(db, {
  taskId: "observed-attempt-budget-exhausted",
  leaseToken: "legacy-retry-4",
  errorClass: "workers_ai_transient_failure",
  errorDetail: "workers_ai_request_failed",
  retryable: true,
  nowMs: legacyFailureAt + 3 * 60 * 60 * 1000,
});
assert.equal(exhaustedImprovement.status, "needs_attention");
assert.equal(exhaustedImprovement.decision.stopReason, "attempt_budget_exhausted");
row = sqlite.prepare("SELECT status, attempts, max_attempts, last_error_class, stop_reason FROM agent_tasks WHERE task_id = 'observed-attempt-budget-exhausted'").get();
assert.deepEqual({ ...row }, {
  status: "needs_attention",
  attempts: 4,
  max_attempts: 4,
  last_error_class: "workers_ai_transient_failure",
  stop_reason: "attempt_budget_exhausted",
});
const policyUpdateReassessment = await reassessImprovementAgentTask(db, "observed-attempt-budget-exhausted", {
  nowMs: legacyFailureAt + 4 * 60 * 60 * 1000,
  policyVersion: 2,
  retryable: true,
  errorClass: "workers_ai_transient_failure",
});
assert.equal(policyUpdateReassessment.status, "waiting");
assert.equal(policyUpdateReassessment.attempts, 4);
assert.equal(policyUpdateReassessment.max_attempts, 5, "A policy update grants at most one additional cumulative attempt");

sqlite.prepare("UPDATE agent_tasks SET status = 'running', attempts = 5, lease_token = 'legacy-retry-5', lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
  .run(toSqliteDateTime(legacyFailureAt + 5 * 60 * 60 * 1000), toSqliteDateTime(legacyFailureAt + 5 * 60 * 60 * 1000), "observed-attempt-budget-exhausted");
const fifthFailure = await recordAgentTaskFailure(db, {
  taskId: "observed-attempt-budget-exhausted",
  leaseToken: "legacy-retry-5",
  errorClass: "workers_ai_transient_failure",
  errorDetail: "workers_ai_request_failed",
  retryable: true,
  nowMs: legacyFailureAt + 5 * 60 * 60 * 1000,
});
assert.equal(fifthFailure.status, "needs_attention");
const thirdPolicyReassessment = await reassessImprovementAgentTask(db, "observed-attempt-budget-exhausted", {
  nowMs: legacyFailureAt + 6 * 60 * 60 * 1000,
  policyVersion: 3,
  retryable: true,
  errorClass: "workers_ai_transient_failure",
});
assert.equal(thirdPolicyReassessment.status, "waiting");
assert.equal(thirdPolicyReassessment.attempts, 5);
assert.equal(thirdPolicyReassessment.max_attempts, 6);

sqlite.prepare("UPDATE agent_tasks SET status = 'running', attempts = 6, lease_token = 'legacy-retry-6', lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
  .run(toSqliteDateTime(legacyFailureAt + 7 * 60 * 60 * 1000), toSqliteDateTime(legacyFailureAt + 7 * 60 * 60 * 1000), "observed-attempt-budget-exhausted");
const sixthFailure = await recordAgentTaskFailure(db, {
  taskId: "observed-attempt-budget-exhausted",
  leaseToken: "legacy-retry-6",
  errorClass: "workers_ai_transient_failure",
  errorDetail: "workers_ai_request_failed",
  retryable: true,
  nowMs: legacyFailureAt + 7 * 60 * 60 * 1000,
});
assert.equal(sixthFailure.status, "needs_attention");
const cappedReassessment = await reassessImprovementAgentTask(db, "observed-attempt-budget-exhausted", {
  nowMs: legacyFailureAt + 8 * 60 * 60 * 1000,
  policyVersion: 4,
  retryable: true,
  errorClass: "workers_ai_transient_failure",
});
assert.equal(cappedReassessment.status, "needs_attention");
assert.equal(cappedReassessment.attempts, 6);
assert.equal(cappedReassessment.max_attempts, 6, "Policy updates must never raise the cumulative six-attempt hard cap");

sqlite.prepare(`
  INSERT INTO agent_tasks (
    task_id, task_type, status, payload_json, attempts, max_attempts,
    created_at, updated_at, deadline_at, next_attempt_at,
    last_error_class, last_error, stop_reason, retry_policy_version
  ) VALUES (?, 'github_query', 'failed', ?, 1, 4,
    '2026-10-31 10:00:00', '2026-10-31 10:00:00', '2026-10-31 18:00:00',
    '2026-10-31 10:00:00', 'unknown', 'Error: unauthorized',
    'non_retryable_or_unknown_error', 0)
`).run("permanent-improvement-failure", JSON.stringify({ improvementRequest: true, prompt: "fix permissions" }));
const permanentReassessment = await reassessImprovementAgentTask(db, "permanent-improvement-failure", {
  nowMs: legacyFailureAt,
  policyVersion: 1,
  retryable: false,
  errorClass: "unauthorized",
});
assert.equal(permanentReassessment.status, "needs_attention");
row = sqlite.prepare("SELECT status, attempts, max_attempts, retry_policy_version, last_error_class, last_error, stop_reason FROM agent_tasks WHERE task_id = 'permanent-improvement-failure'").get();
assert.deepEqual({ ...row }, {
  status: "needs_attention",
  attempts: 1,
  max_attempts: 4,
  retry_policy_version: 1,
  last_error_class: "unauthorized",
  last_error: "Error: unauthorized",
  stop_reason: "non_retryable_or_unknown_error",
});

sqlite.close();
console.log("Agent task AI token reservation settlement tests passed.");
