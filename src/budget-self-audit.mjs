const WORKFLOW_STEP_DAILY_ALLOCATION = 3_000;
const WORKFLOW_STEP_ADMISSION_BUDGET = 2_700;
const WORKERS_AI_FREE_DAILY_NEURONS = 10_000;
const AUDIT_KEY_PREFIX = "budget-audit:";

function countByStatus(groups, status) {
  return Number(groups.find((item) => item.status === status)?.count || 0);
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

function buildAuditNote(day, report) {
  const findingLines = report.findings.length
    ? report.findings.map((item) => "- " + item.code + ": " + JSON.stringify(item.details)).join("\n")
    : "- 定量メトリクス上の警告はありません。";
  return [
    "---",
    "origin: budget-audit",
    "audit_generated: true",
    "---",
    "",
    "# Akatuki-Knowledge 定期自己監査 " + day,
    "",
    "## 何が困っているか",
    "",
    "定期自己監査で、運用メトリクスとシステム構成の改善余地を確認する必要があります。",
    "",
    "## どうなっていてほしいか",
    "",
    "Cloudflare Free の実際のクォータを超えず、処理を不必要なアプリ側の件数・トークン制限で止めず、改善依頼を最後まで実行できる状態にしてください。",
    "",
    "## どうなれば直ったと言えるか",
    "",
    "- 現行 main の実装、テスト、Workflow、D1 migration、Cloudflare 設定を実際に確認している",
    "- 不具合・ボトルネック・不足しているテストを、根拠と影響度付きで示している",
    "- 必要な変更があれば、関連する実装・テスト・migration・ドキュメントをまとめて変更したPRを作成している",
    "- 変更が不要なら、その根拠を記録し、無意味なPRを作らない",
    "- デプロイや本番migrationの適用は実行せず、必要な手順と前提を明記する",
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
    "## 監査対象と実行方針",
    "",
    "リポジトリ Akatuki1121/Akatuki-Knowledge の main を対象に、少なくとも以下を横断して監査してください。",
    "",
    "- Worker本体、Agent Workflow、改善ノートの自動処理、自己監査",
    "- Workers AIのCloudflare Free枠、モデル仕様、エラー時の待機と日次リセット後の再開",
    "- Workflows / D1 / Durable Objects / YAOS の無料枠とアプリ側予約の整合性",
    "- D1 migration履歴と本番デプロイ条件の整合性",
    "- GitHub Actions、必須チェック、Purge方式のsquash自動マージ",
    "- 失敗時の回復、冪等性、重複実行、ログの個人情報・認証情報保護",
    "- 実装を妨げている不要な件数制限や重複した安全ゲート",
    "",
    "改善が必要な場合は、対象を狭めて見送るのではなく、依存する変更・テスト・migration・ドキュメントを一つの整合したPRにまとめてください。既存の安全性と必須CIは弱めず、自己監査が自身を再起動する循環は作らないでください。",
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
    aiUsage = await env.DB.prepare("SELECT reserved_neurons, actual_neurons, calls_failed, calls_completed FROM workers_ai_daily_usage WHERE usage_day = ?").bind(day).first();
  } catch {
    // Workers AI usage telemetry is optional; Cloudflare itself remains the quota authority.
  }

  const summary = summarizeFindings({ budget, taskGroups, errorGroups, aiUsage });
  const report = {
    version: 1,
    day,
    checkedAt,
    status: summary.status,
    findings: summary.findings,
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
