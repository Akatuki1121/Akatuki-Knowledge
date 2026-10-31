import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { enqueueAgentTask } from "../src/background-task-store.mjs";

const root = new URL("../", import.meta.url);
const schema = await readFile(new URL("schema-snapshots/live-d1-schema-2026-10-19.sql", root), "utf8");
const migration = await readFile(new URL("migrations/0011_agent_tasks.sql", root), "utf8");
const attentionMigration = await readFile(new URL("migrations/0019_agent_task_attention_and_reassessment.sql", root), "utf8");

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(schema);
sqlite.exec(migration);
sqlite.exec(attentionMigration);
const db = new D1Database(sqlite);
const request = {
  taskType: "knowledge_query",
  idempotencyKey: "test:same-request",
  payload: { prompt: "Find the deployment decision", maxOutputTokens: 512 },
  nowMs: Date.parse("2026-10-22T12:00:00Z"),
};

const first = await enqueueAgentTask(db, { ...request, taskId: "task-original" });
assert.equal(first.created, true);
assert.equal(first.task.budget_reserved, 1);
assert.match(first.task.payload.inputHash, /^[a-f0-9]{64}$/);
assert.deepEqual(first.task.payload, { ...request.payload, inputHash: first.task.payload.inputHash });

const sameRequest = await enqueueAgentTask(db, { ...request, taskId: "task-duplicate" });
assert.equal(sameRequest.created, false);
assert.equal(sameRequest.task.task_id, "task-original");
assert.equal(sameRequest.task.payload.inputHash, first.task.payload.inputHash);

await assert.rejects(
  enqueueAgentTask(db, {
    ...request,
    taskId: "task-conflict",
    payload: { ...request.payload, prompt: "A different request" },
  }),
  (error) => error?.message === "idempotency_key_conflict",
);

const tasks = sqlite.prepare("SELECT task_id FROM agent_tasks ORDER BY task_id").all();
assert.deepEqual(tasks.map((task) => task.task_id), ["task-original"]);
const budget = sqlite.prepare(
  "SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = '2026-10-22'",
).get();
assert.deepEqual({ ...budget }, { tasks_reserved: 1, workflow_steps_reserved: 32 });

console.log("Background task idempotency tests passed: input hash persistence, duplicate replay, conflict rejection, and no duplicate budget reservation.");
