import assert from "node:assert/strict";
import { buildFailureInventory, runBudgetSelfAudit, summarizeFindings } from "../src/budget-self-audit.mjs";

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

// Failure inventory fixtures use the error text exactly as production
// recorded it (see the 2026-11-14 failure evidence inventory): the stored
// last_error carries the "Error: " prefix and, for input errors, the
// "invalid_input:<suffix>" shape; the Workers AI timeout keeps its
// elapsed_ms / max_tokens context after the reason.
const failureRowsFixture = [
  {
    task_id: "1009518a-b438-459b-9df7-a5f5ba16009b",
    last_error_class: "invalid_input",
    last_error: "Error: invalid_input:model_response_not_json",
    payload_json: JSON.stringify({ improvementRequest: true, improvementNotePath: "Notes/改善/自己監査-2026-11-07.md" }),
    created_at: "2026-11-08 01:02:03",
    updated_at: "2026-11-08 03:04:05",
  },
  {
    task_id: "2830c7a3-623f-440f-85ed-62e77e968a2d",
    last_error_class: "invalid_input",
    last_error: "Error: invalid_input:action_shape",
    payload_json: JSON.stringify({ improvementRequest: true, improvementNotePath: "Notes/改善/自己監査-2026-11-05.md" }),
    created_at: "2026-11-07 01:02:03",
    updated_at: "2026-11-07 03:04:05",
  },
  {
    task_id: "e4d16479-e5db-4622-aaad-07875dac035c",
    last_error_class: "invalid_input",
    last_error: "Error: invalid_input:action_shape",
    payload_json: JSON.stringify({ improvementRequest: true, improvementNotePath: "Notes/改善/自己監査-2026-11-02.md" }),
    created_at: "2026-11-05 01:02:03",
    updated_at: "2026-11-05 03:04:05",
  },
  {
    task_id: "d5a8cea8-85c8-434a-a60b-9e5eea92cba4",
    last_error_class: "workers_ai_transient_failure",
    last_error: "Error: workers_ai_request_failed;elapsed_ms=235684;max_tokens=125158: AiError: 3046: Request timeout",
    payload_json: JSON.stringify({ improvementRequest: true, improvementNotePath: "Notes/改善/自己監査-2026-11-10.md" }),
    created_at: "2026-11-10 01:02:03",
    updated_at: "2026-11-10 03:04:05",
  },
  {
    task_id: "52da7b7e-5a07-4219-b5e8-09087f4f8615",
    last_error_class: "workers_ai_transient_failure",
    last_error: "Error: workers_ai_request_failed;elapsed_ms=235717;max_tokens=125158: AiError: 3046: Request timeout",
    payload_json: JSON.stringify({ improvementRequest: true, improvementNotePath: "Notes/改善/自己監査-2026-11-12.md" }),
    created_at: "2026-11-12 01:02:03",
    updated_at: "2026-11-12 03:04:05",
  },
  {
    task_id: "86208436-3dcb-4671-878a-1f56041f3a8d",
    last_error_class: "lease_lost",
    last_error: "Error: lease_lost",
    payload_json: JSON.stringify({ taskType: "github_query" }),
    created_at: "2026-11-09 01:02:03",
    updated_at: "2026-11-09 03:04:05",
  },
];

const inventory = buildFailureInventory(failureRowsFixture);
assert.deepEqual(inventory.map((item) => [item.shape, item.count]), [
  ["workers_ai_transient_failure", 2],
  ["invalid_input:action_shape", 2],
  ["lease_lost", 1],
  ["invalid_input:model_response_not_json", 1],
], "Shapes group by error class plus suffix, most frequent and most recent first");
const actionShape = inventory.find((item) => item.shape === "invalid_input:action_shape");
assert.equal(actionShape.errorClass, "invalid_input");
assert.equal(actionShape.suffix, "action_shape");
assert.equal(actionShape.modelResponseShape, true, "action_shape is a model response-shape suffix");
assert.deepEqual(actionShape.representatives.map((row) => row.taskId), [
  "2830c7a3-623f-440f-85ed-62e77e968a2d",
  "e4d16479-e5db-4622-aaad-07875dac035c",
], "Representatives are the most recent tasks first");
assert.equal(actionShape.representatives[0].notePath, "Notes/改善/自己監査-2026-11-05.md");
assert.equal(actionShape.firstSeenAt, "2026-11-05 03:04:05");
assert.equal(actionShape.lastSeenAt, "2026-11-07 03:04:05");
const timeoutShape = inventory.find((item) => item.shape === "workers_ai_transient_failure");
assert.equal(timeoutShape.suffix, null, "The timeout text carries no class suffix, so it must not invent one");
assert.equal(timeoutShape.modelResponseShape, false);
const leaseShape = inventory.find((item) => item.shape === "lease_lost");
assert.equal(leaseShape.representatives[0].notePath, null, "Non-improvement tasks have no improvement note path");
assert.deepEqual(buildFailureInventory([]), []);
assert.deepEqual(buildFailureInventory(undefined), []);

const inventorySummary = summarizeFindings({ failureRows: failureRowsFixture });
assert.deepEqual(inventorySummary.failureInventory, inventory, "summarizeFindings carries the failure inventory");
assert.deepEqual(summarizeFindings({}).failureInventory, [], "Missing rows produce an empty inventory, not an error");

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
              if (sql.includes("payload_json")) return { results: failureRowsFixture };
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
assert.deepEqual(first.report.failureInventory, inventory, "The stored audit report carries the 7-day failure inventory");
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
