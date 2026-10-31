import assert from "node:assert/strict";
import { runBudgetSelfAudit, summarizeFindings } from "../src/budget-self-audit.mjs";

const summary = summarizeFindings({
  budget: { tasks_reserved: 55, workflow_steps_reserved: 2300 },
  taskGroups: [{ status: "failed", count: 6 }, { status: "succeeded", count: 10 }],
  errorGroups: [{ error_class: "upstream_5xx", count: 3 }],
  aiUsage: { reserved_neurons: 8500, actual_neurons: 100, calls_failed: 2, calls_completed: 8 },
});
assert.equal(summary.status, "attention");
assert.deepEqual(summary.findings.map((item) => item.code), [
  "repeated_error_class",
  "high_task_failure_ratio",
  "workflow_budget_near_limit",
  "workers_ai_budget_near_limit",
]);

function fakeDb(existingAudit = null) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("SELECT value FROM app_meta WHERE key = ?")) return existingAudit ? { value: JSON.stringify(existingAudit) } : null;
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

let createdNote = null;
const attentionDb = fakeDb();
const attention = await runBudgetSelfAudit({ DB: attentionDb }, Date.parse("2026-10-30T00:00:00.000Z"), {
  includeSystemAudit: true,
  createNote: async (note) => { createdNote = note; return { ok: true, status: 201 }; },
});
assert.equal(attention.ok, true);
assert.equal(attention.noteCreated, true);
assert.match(createdNote.path, /^Notes\/改善\/自己監査-2026-10-30\.md$/u);
assert.match(createdNote.content, /origin: budget-audit/);
assert.match(createdNote.content, /audit_generated: true/);


const existingReport = { day: "2026-10-30", status: "normal", noteCreated: true };
const duplicateDb = fakeDb(existingReport);
let duplicateNoteCalls = 0;
const duplicate = await runBudgetSelfAudit({ DB: duplicateDb }, Date.parse("2026-10-30T12:00:00.000Z"), {
  includeSystemAudit: true,
  createNote: async () => { duplicateNoteCalls++; return { ok: true, status: 201 }; },
});
assert.equal(duplicate.ok, true);
assert.equal(duplicate.recorded, false);
assert.equal(duplicate.noteCreated, true, "A duplicate audit response must report the note state stored in its report");
assert.deepEqual(duplicate.report, existingReport);
assert.equal(duplicateNoteCalls, 0);
assert.equal(duplicateDb.writes.length, 0);


const missingNoteDb = fakeDb({
  day: "2026-10-30",
  checkedAt: "2026-10-30T23:55:00.000Z",
  status: "attention",
  findings: [{ code: "repeated_error_class", details: { count: 3 } }],
  metrics: {
    tasksTotal: 0, failedTasks: 0, workflowStepsReserved: 0,
    workersAiNeuronsReserved: 0, workersAiNeuronsActual: 0,
    workersAiCallsCompleted: 0, workersAiCallsFailed: 0,
  },
  noteCreated: false,
});
let noteAttempts = 0;
const noteFailure = await runBudgetSelfAudit({ DB: missingNoteDb }, Date.parse("2026-10-30T23:55:00.000Z"), {
  includeSystemAudit: true,
  createNote: async () => { noteAttempts++; return { ok: false, status: 503 }; },
});
assert.equal(noteFailure.ok, true, "A note API failure must not discard the already-recorded audit report");
assert.equal(noteFailure.recorded, false);
assert.equal(noteFailure.noteCreated, false);
assert.equal(noteFailure.report.noteError, "audit_note_creation_failed");
assert.equal(noteAttempts, 1);

const noteRetry = await runBudgetSelfAudit({ DB: missingNoteDb }, Date.parse("2026-10-31T00:05:00.000Z"), {
  includeSystemAudit: true,
  createNote: async () => { noteAttempts++; return { ok: true, status: 201 }; },
});
assert.equal(noteRetry.ok, true);
assert.equal(noteRetry.recorded, false);
assert.equal(noteRetry.noteCreated, true, "An existing report without its note must retry note creation on a later run");
assert.equal(noteRetry.report.noteError, null);
assert.equal(noteAttempts, 2);
assert.equal(missingNoteDb.writes.length, 2, "Both note failure and successful retry must update the durable audit report");

const cronInstant = new Date("2026-10-30T23:55:00.000Z");
const tokyoParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
}).formatToParts(cronInstant);
const tokyoDay = [
  tokyoParts.find((part) => part.type === "year").value,
  tokyoParts.find((part) => part.type === "month").value,
  tokyoParts.find((part) => part.type === "day").value,
].join("-");
assert.equal(cronInstant.toISOString().slice(0, 10), "2026-10-30");
assert.equal(tokyoDay, "2026-10-31", "The 23:55 UTC audit is dated on the following local Japan day");

console.log("budget self-audit tests passed");
