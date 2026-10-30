import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { reserveAgentAiBudget, settleAgentAiBudget, toSqliteDateTime } from "../src/background-task-store.mjs";

const root = new URL("../", import.meta.url);
const schema = await readFile(new URL("schema-snapshots/live-d1-schema-2026-10-19.sql", root), "utf8");
const taskMigration = await readFile(new URL("migrations/0011_agent_tasks.sql", root), "utf8");
const budgetMigration = await readFile(new URL("migrations/pending/0017_cloudflare_free_workflow_budget.sql", root), "utf8");

class D1Statement {
  constructor(sqlite, sql) { this.sqlite = sqlite; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  first() { return this.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  run() { const result = this.sqlite.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}
class D1Database {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
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

sqlite.close();
console.log("Agent task AI token reservation settlement tests passed.");
