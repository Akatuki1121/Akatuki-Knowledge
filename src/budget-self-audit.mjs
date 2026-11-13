import { MODEL_RESPONSE_SHAPE_INVALID_INPUT_SUFFIXES } from "./background-task-policy.mjs";

const WORKFLOW_STEP_DAILY_ALLOCATION = 3_000;
const WORKFLOW_STEP_ADMISSION_BUDGET = 2_700;
const WORKERS_AI_FREE_DAILY_NEURONS = 10_000;
const AUDIT_KEY_PREFIX = "budget-audit:";
const FAILURE_INVENTORY_WINDOW_DAYS = 7;
const FAILURE_INVENTORY_ROW_LIMIT = 500;
const FAILURE_INVENTORY_REPRESENTATIVE_LIMIT = 3;

function countByStatus(groups, status) {
  return Number(groups.find((item) => item.status === status)?.count || 0);
}

// The recorded error text carries the class and, for input errors, a suffix
// after a colon (e.g. "Error: invalid_input:model_response_not_json"). The
// suffix is the shape discriminator: suffixes listed in
// MODEL_RESPONSE_SHAPE_INVALID_INPUT_SUFFIXES come from the model's own
// response shape, everything else is input-side or infrastructure.
function failureSuffix(errorClass, errorText) {
  if (typeof errorClass !== "string" || !errorClass || typeof errorText !== "string") return null;
  const marker = errorClass + ":";
  const at = errorText.indexOf(marker);
  if (at < 0) return null;
  const match = errorText.slice(at + marker.length).match(/^[a-z0-9_]+/u);
  return match ? match[0] : null;
}

function failureNotePath(payloadJson) {
  if (typeof payloadJson !== "string" || !payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson);
    return typeof payload?.improvementNotePath === "string" ? payload.improvementNotePath : null;
  } catch {
    return null;
  }
}

/**
 * Group recent failed-task rows into an evidence bundle by failure shape
 * (error class plus suffix). Counting stays in code; the model never sees
 * raw rows. Rows are the agent_tasks records of the last
 * FAILURE_INVENTORY_WINDOW_DAYS days with a recorded error class.
 */
export function buildFailureInventory(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const errorClass = typeof row?.last_error_class === "string" && row.last_error_class
      ? row.last_error_class : "unknown";
    const suffix = failureSuffix(errorClass, row.last_error);
    const shape = suffix ? errorClass + ":" + suffix : errorClass;
    let group = groups.get(shape);
    if (!group) {
      group = {
        shape,
        errorClass,
        suffix,
        modelResponseShape: suffix !== null && MODEL_RESPONSE_SHAPE_INVALID_INPUT_SUFFIXES.includes(suffix),
        count: 0,
        rows: [],
        firstSeenAt: null,
        lastSeenAt: null,
      };
      groups.set(shape, group);
    }
    group.count++;
    const seenAt = typeof row.updated_at === "string" ? row.updated_at : null;
    if (seenAt) {
      if (group.firstSeenAt === null || seenAt < group.firstSeenAt) group.firstSeenAt = seenAt;
      if (group.lastSeenAt === null || seenAt > group.lastSeenAt) group.lastSeenAt = seenAt;
    }
    group.rows.push({
      taskId: typeof row.task_id === "string" ? row.task_id : null,
      notePath: failureNotePath(row.payload_json),
      seenAt,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      shape: group.shape,
      errorClass: group.errorClass,
      suffix: group.suffix,
      modelResponseShape: group.modelResponseShape,
      count: group.count,
      representatives: group.rows
        .sort((a, b) => String(b.seenAt || "").localeCompare(String(a.seenAt || "")))
        .slice(0, FAILURE_INVENTORY_REPRESENTATIVE_LIMIT)
        .map((row) => ({ taskId: row.taskId, notePath: row.notePath })),
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
    }))
    .sort((a, b) => b.count - a.count
      || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""))
      || a.shape.localeCompare(b.shape));
}

export function summarizeFindings(input = {}) {
  const taskGroups = Array.isArray(input.taskGroups) ? input.taskGroups : [];
  const errorGroups = Array.isArray(input.errorGroups) ? input.errorGroups : [];
  const tasksTotal = taskGroups.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const failedTasks = countByStatus(taskGroups, "failed");
  const findings = [];

  for (const item of errorGroups) {
    if (Number(item.count || 0) >= 3) {
      findings.push({
        code: "repeated_error_class",
        severity: "warning",
        details: { errorClass: String(item.error_class || "unknown"), occurrences: Number(item.count) },
      });
    }
  }

  if (tasksTotal >= 5 && failedTasks / tasksTotal >= 0.3) {
    findings.push({
      code: "high_task_failure_ratio",
      severity: "warning",
      details: { failed: failedTasks, total: tasksTotal, ratio: failedTasks / tasksTotal },
    });
  }

  const workflowSteps = Number(input.budget?.workflow_steps_reserved || 0);
  if (workflowSteps >= WORKFLOW_STEP_ADMISSION_BUDGET * 0.8) {
    findings.push({
      code: "workflow_budget_near_limit",
      severity: "warning",
      details: {
        reservedSteps: workflowSteps,
        admissionBudget: WORKFLOW_STEP_ADMISSION_BUDGET,
        CloudflareFreeAllocation: WORKFLOW_STEP_DAILY_ALLOCATION,
      },
    });
  }

  const aiUsed = Number(input.aiUsage?.reserved_neurons || 0) + Number(input.aiUsage?.actual_neurons || 0);
  if (aiUsed >= WORKERS_AI_FREE_DAILY_NEURONS * 0.8) {
    findings.push({
      code: "workers_ai_budget_near_limit",
      severity: "warning",
      details: { reservedNeurons: Number(input.aiUsage?.reserved_neurons || 0), actualNeurons: Number(input.aiUsage?.actual_neurons || 0), freeDailyAllocation: WORKERS_AI_FREE_DAILY_NEURONS },
    });
  }

  return {
    status: findings.length ? "attention" : "normal",
    findings,
    failureInventory: buildFailureInventory(input.failureRows),
    metrics: {
      tasksTotal,
      failedTasks,
      workflowStepsReserved: workflowSteps,
      workersAiNeuronsReserved: Number(input.aiUsage?.reserved_neurons || 0),
      workersAiNeuronsActual: Number(input.aiUsage?.actual_neurons || 0),
      workersAiCallsFailed: Number(input.aiUsage?.calls_failed || 0),
      workersAiCallsCompleted: Number(input.aiUsage?.calls_completed || 0),
    },
  };
}

export function buildAuditNote(day, report) {
  const findingLines = report.findings.length
    ? report.findings.map((item) => "- " + item.code + ": " + JSON.stringify(item.details)).join("\n")
    : "- 定量メトリクス上の警告はありません。";
  const inventory = Array.isArray(report.failureInventory) ? report.failureInventory : [];
  const inventoryLines = inventory.length
    ? inventory.map((item) => {
      const representatives = (Array.isArray(item.representatives) ? item.representatives : [])
        .filter((row) => typeof row?.taskId === "string" && row.taskId)
        .map((row) => (row.notePath ? row.taskId + "（" + row.notePath + "）" : row.taskId))
        .join("、");
      return "- " + item.shape + ": " + item.count + "件（最初: " + (item.firstSeenAt || "不明")
        + "、直近: " + (item.lastSeenAt || "不明") + "）"
        + (representatives ? "\n  - 代表タスク: " + representatives : "");
    }).join("\n")
    : "- 直近7日に記録された失敗はありません。";
  return [
    "---",
    "origin: budget-audit",
    "audit_generated: true",
    "---",
    "",
    "# Akatuki-Knowledge 定期自己監査 " + day,
    "",
    "これは Muse 宛ての監査材料です。改善エージェントが自動で取り込む実行用の依頼ではなく、自己監査は定量の集計と失敗の棚卸しをここへ届け、横断的な見立てと改善方針の判断は Muse 側で行います。",
    "",
    "## 今回の定量監査結果",
    "",
    "- 確認日時: " + report.checkedAt,
    "- 状態: " + report.status,
    "- 直近24時間のタスク: " + report.metrics.tasksTotal,
    "- 失敗タスク: " + report.metrics.failedTasks,
    "- Workflow予約steps: " + report.metrics.workflowStepsReserved,
    "- Workers AI予約Neurons: " + report.metrics.workersAiNeuronsReserved,
    "- Workers AI実消費Neurons: " + report.metrics.workersAiNeuronsActual,
    "- Workers AI成功/失敗呼び出し: " + report.metrics.workersAiCallsCompleted + "/" + report.metrics.workersAiCallsFailed,
    "",
    findingLines,
    "",
    "## 失敗の棚卸し（直近7日）",
    "",
    inventoryLines,
    "",
    "## 確認観点",
    "",
    "- 繰り返している失敗の形が、実装の不具合か、ポリシーの区切りか、入力側の問題か",
    "- 予算（Workflow steps と Workers AI Neurons）の配分に、無駄や偏りがないか",
    "- 失敗の回復（再試行、再評価、リース回復）が、記録の上で効いているか",
    "- 前回の監査以降、同じ形の失敗が減っているか増えているか",
  ].join("\n");
}

async function tryCreateAuditNote(env, day, report, options, checkedAt) {
  const shouldCreate = typeof options.createNote === "function"
    && (options.includeSystemAudit === true || report.findings.length > 0);
  if (!shouldCreate) return { attempted: false, noteCreated: false, noteError: null };

  const path = "Notes/改善/自己監査-" + day + ".md";
  try {
    const response = await options.createNote({
      path,
      title: "Akatuki-Knowledge 定期自己監査 " + day,
      content: buildAuditNote(day, report),
      tags: ["Akatuki-Knowledge", "自己監査", "自動改善"],
    });
    if (response?.ok === true || response?.status === 201 || response?.alreadyExists === true) {
      return { attempted: true, noteCreated: true, noteError: null };
    }
    if (response?.status === 409) {
      const existingNote = await env.DB.prepare(
        "SELECT id FROM notes WHERE path = ? AND deleted_at IS NULL"
      ).bind(path).first();
      if (existingNote) return { attempted: true, noteCreated: true, noteError: null };
    }
    return { attempted: true, noteCreated: false, noteError: "audit_note_creation_failed" };
  } catch {
    // Keep the report durable and retry note creation on the next audit run.
    return { attempted: true, noteCreated: false, noteError: "audit_note_creation_failed" };
  }
}

async function saveAuditReport(env, auditKey, report, checkedAt) {
  await env.DB.prepare(
    "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(auditKey, JSON.stringify(report), checkedAt).run();
}

export async function runBudgetSelfAudit(env, nowMs = Date.now(), options = {}) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    return { ok: false, recorded: false, reason: "audit_database_unavailable" };
  }

  const checkedAt = new Date(nowMs).toISOString();
  const day = checkedAt.slice(0, 10);
  const auditKey = AUDIT_KEY_PREFIX + day + ":00";
  const existing = await env.DB.prepare("SELECT value FROM app_meta WHERE key = ?").bind(auditKey).first();
  if (existing?.value) {
    let report = null;
    try { report = JSON.parse(existing.value); } catch { report = null; }
    if (!report) return { ok: false, recorded: false, reason: "audit_report_unreadable" };

    if (report.noteCreated === true) {
      return { ok: true, recorded: false, noteCreated: true, report };
    }
    const noteResult = await tryCreateAuditNote(env, day, report, options, checkedAt);
    if (!noteResult.attempted) {
      return { ok: true, recorded: false, noteCreated: report.noteCreated === true, report };
    }
    const updatedReport = {
      ...report,
      noteCreated: noteResult.noteCreated,
      noteError: noteResult.noteError,
      noteLastAttemptAt: checkedAt,
    };
    await saveAuditReport(env, auditKey, updatedReport, checkedAt);
    return {
      ok: true,
      recorded: false,
      noteCreated: noteResult.noteCreated,
      report: updatedReport,
    };
  }

  let budget = null;
  let taskGroups = [];
  let errorGroups = [];
  let failureRows = [];
  let aiUsage = null;
  const nowSql = checkedAt.slice(0, 19).replace("T", " ");

  try {
    budget = await env.DB.prepare("SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?").bind(day).first();
  } catch {
    // The audit still runs if an earlier production schema has not received this table.
  }
  try {
    taskGroups = (await env.DB.prepare("SELECT status, COUNT(*) AS count FROM agent_tasks WHERE created_at >= datetime(?, '-1 day') GROUP BY status").bind(nowSql).all()).results || [];
  } catch {
    // Missing task schema is reported below rather than preventing the scheduled audit.
  }
  try {
    errorGroups = (await env.DB.prepare("SELECT last_error_class AS error_class, COUNT(*) AS count FROM agent_tasks WHERE updated_at >= datetime(?, '-1 day') AND last_error_class IS NOT NULL GROUP BY last_error_class HAVING COUNT(*) >= 3 ORDER BY count DESC").bind(nowSql).all()).results || [];
  } catch {
    // Error history is optional until the task schema is available.
  }
  try {
    failureRows = (await env.DB.prepare(
      "SELECT task_id, last_error_class, last_error, payload_json, created_at, updated_at FROM agent_tasks "
      + "WHERE last_error_class IS NOT NULL AND updated_at >= datetime(?, '-" + FAILURE_INVENTORY_WINDOW_DAYS + " days') "
      + "ORDER BY updated_at DESC LIMIT " + FAILURE_INVENTORY_ROW_LIMIT
    ).bind(nowSql).all()).results || [];
  } catch {
    // The failure inventory is evidence for triage; its absence must not stop the audit.
  }
  try {
    aiUsage = await env.DB.prepare("SELECT reserved_neurons, actual_neurons, calls_failed, calls_completed FROM workers_ai_daily_usage WHERE usage_day = ?").bind(day).first();
  } catch {
    // Workers AI usage telemetry is optional; Cloudflare itself remains the quota authority.
  }

  const summary = summarizeFindings({ budget, taskGroups, errorGroups, failureRows, aiUsage });
  const report = {
    version: 1,
    day,
    checkedAt,
    status: summary.status,
    findings: summary.findings,
    failureInventory: summary.failureInventory,
    metrics: summary.metrics,
    telemetry: {
      workflowBudgetAvailable: Boolean(budget),
      taskHistoryAvailable: taskGroups.length > 0,
      workersAiUsageAvailable: Boolean(aiUsage),
    },
  };

  // Persist the report before attempting the note write. A note/API failure
  // must not erase the daily audit, and the next run can retry the note.
  const initialReport = { ...report, noteCreated: false };
  await saveAuditReport(env, auditKey, initialReport, checkedAt);
  const noteResult = await tryCreateAuditNote(env, day, report, options, checkedAt);
  const storedReport = {
    ...report,
    noteCreated: noteResult.noteCreated,
    ...(noteResult.noteError ? { noteError: noteResult.noteError, noteLastAttemptAt: checkedAt } : {}),
  };
  if (noteResult.attempted) {
    await saveAuditReport(env, auditKey, storedReport, checkedAt);
  }

  return {
    ok: true,
    recorded: true,
    noteCreated: noteResult.noteCreated,
    report: storedReport,
  };
}
