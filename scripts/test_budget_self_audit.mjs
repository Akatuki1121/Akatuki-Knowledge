import assert from "node:assert/strict";
import { runBudgetSelfAudit, summarizeFindings } from "../src/budget-self-audit.mjs";

const summary = summarizeFindings({
  budget: { tasks_reserved: 55, workflow_steps_reserved: 2300 },
  taskGroups: [{ status: "failed", count: 6 }, { status: "succeeded", count: 10 }],
  errorGroups: [{ error_class: "upstream_5xx", count: 3 }],
  aiUsage: { reserved_neurons: 6500, actual_neurons: 100, calls_failed: 2, calls_completed: 8 },
});
assert.equal(summary.status, "attention");
assert.deepEqual(summary.findings.map((item) => item.code), [
  "repeated_error_class",
  "high_task_failure_ratio",
  "workflow_budget_near_limit",
  "workers_ai_budget_near_limit",
]);

function fakeDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("agent_task_daily_budget")) return { tasks_reserved: 2, workflow_steps_reserved: 64 };
              if (sql.includes("workers_ai_daily_usage")) return { reserved_neurons: 100, actual_neurons: 50, calls_failed: 0, calls_completed: 2 };
              return null;
            },
            async all() {
              if (sql.includes("GROUP BY status")) return { results: [{ status: "succeeded", count: 2 }] };
              if (sql.includes("GROUP BY last_error_class")) return { results: [] };
              return { results: [] };
            },
            async run() {
              writes.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const db = fakeDb();
const env = { DB: db };
const first = await runBudgetSelfAudit(env, Date.parse("2026-10-30T00:00:00.000Z"));
assert.equal(first.ok, true);
assert.equal(first.recorded, true);
assert.equal(first.report.status, "normal");
assert.equal(db.writes.length, 1);
assert.match(db.writes[0].args[0], /budget-audit:2026-10-30:00/);

console.log("budget self-audit tests passed");
