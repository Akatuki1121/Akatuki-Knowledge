const MAX_RUNS_PER_DAY = 2;
const MAX_AUDIT_IMPROVEMENTS_PER_DAY = 1;
const MAX_OPEN_AUDIT_IMPROVEMENTS = 3;
const WORKFLOW_WARNING_RATIO = 0.8;
const AI_WARNING_RATIO = 0.8;

function utcTimestamp(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 19).replace("T", " ");
}

function summarizeFindings({ budget, taskGroups, errorGroups, aiUsage }) {
  const findings = [];
  const totalTasks = taskGroups.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const failedTasks = taskGroups.filter((row) => row.status === "failed")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const workflowReserved = Number(budget?.workflow_steps_reserved || 0);
  const aiReserved = Number(aiUsage?.reserved_neurons || 0);
  const aiActual = Number(aiUsage?.actual_neurons || 0);
  const aiTotal = aiReserved + aiActual;

  for (const row of errorGroups) {
    if (Number(row.count || 0) >= 3) {
      findings.push({
        severity: "warning",
        code: "repeated_error_class",
        errorClass: row.error_class,
        count: Number(row.count),
      });
    }
  }
  if (totalTasks >= 10 && failedTasks >= 5 && failedTasks / totalTasks >= 0.3) {
    findings.push({
      severity: "warning",
      code: "high_task_failure_ratio",
      failedTasks,
      totalTasks,
      ratio: Number((failedTasks / totalTasks).toFixed(3)),
    });
  }
  if (workflowReserved >= 2700 * WORKFLOW_WARNING_RATIO) {
    findings.push({
      severity: "warning",
      code: "workflow_budget_near_limit",
      reservedSteps: workflowReserved,
      limit: 2700,
    });
  }
  if (aiUsage && aiTotal >= 8000 * AI_WARNING_RATIO) {
    findings.push({
      severity: "warning",
      code: "workers_ai_budget_near_limit",
      reservedNeurons: aiReserved,
      actualNeurons: aiActual,
      limit: 8000,
    });
  }

  return {
    windowHours: 24,
    taskCount: totalTasks,
    failedTaskCount: failedTasks,
    workflow: {
      tasksReserved: Number(budget?.tasks_reserved || 0),
      stepsReserved: workflowReserved,
      appLimitSteps: 2700,
      source: budget ? "agent_task_daily_budget" : "unavailable",
    },
    workersAi: aiUsage
      ? {
          reservedNeurons: aiReserved,
          actualNeurons: aiActual,
          failedCalls: Number(aiUsage.calls_failed || 0),
          completedCalls: Number(aiUsage.calls_completed || 0),
          appLimitNeurons: 8000,
          source: "workers_ai_daily_usage",
        }
      : { source: "unavailable", note: "AI usage ledger is not available; no zero-usage assumption is made." },
    findings,
    status: findings.some((item) => item.severity === "warning") ? "attention" : "normal",
  };
}

/**
 * Deterministic, read-only operational audit. It deliberately makes no model
 * calls and writes only a compact report to app_meta. The two UTC slots and
 * unique keys cap persistence at two reports per day and prevent recursion.
 */
async function createAuditImprovementRequest(env, report, nowMs) {
  if (!report.findings.length) return { created: false, reason: "no_actionable_findings" };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const auditKey = "budget-audit-improvement:" + day;
  const now = utcTimestamp(nowMs);
  const claimed = await env.DB.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, 'claimed', ?) ON CONFLICT(key) DO NOTHING").bind(auditKey, now).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return { created: false, reason: "daily_improvement_limit" };
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM notes WHERE path LIKE 'Notes/改善/自動監査-%' AND deleted_at IS NULL AND updated_at >= ?").bind(utcTimestamp(nowMs - 30 * 24 * 60 * 60 * 1000)).first();
  if (Number(recent?.count || 0) >= MAX_OPEN_AUDIT_IMPROVEMENTS) {
    await env.DB.prepare("UPDATE app_meta SET value = 'blocked_open_limit', updated_at = ? WHERE key = ?").bind(now, auditKey).run();
    return { created: false, reason: "open_improvement_limit" };
  }
  const path = "Notes/改善/自動監査-" + day + ".md";
  if (await env.DB.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first()) return { created: false, reason: "note_already_exists" };
  const syncUuid = crypto.randomUUID();
  const title = "自動監査による改善依頼 " + day;
  const content = [
    "<!-- budget-audit-generated:v1 -->",
    "origin: budget-audit",
    "audit_generated: true",
    "",
    "# 自動監査による改善依頼",
    "",
    "監査日時: " + new Date(nowMs).toISOString(),
    "",
    "## 依頼",
    "",
    "以下の監査結果を根拠に、Akatuki-Knowledge の現行コードを調査し、再現可能な原因を特定して修正・テストし、レビュー用Pull Requestを作成してください。監査結果だけから原因を断定せず、コードと既存テストを確認してください。根拠が弱い場合は変更せず、理由を報告してください。",
    "変更範囲は src/、scripts/、docs/ に限定します。migrations、.github、Cloudflare設定、Secrets、権限、デプロイ、マージは禁止です。PRは作成しますが、自動マージは有効化しません。レビューとマージ判断はオーナーに残します。",
    "",
    "## 監査結果",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
    "## 完了条件",
    "",
    "- 根拠をコード位置・既存テストで示す",
    "- 修正と回帰テストを追加する",
    "- 関連チェックを実行し結果を記録する",
    "- PRを作成し、このノートにPR URLと結果を記録する",
    "- 修正不要なら、その判断根拠を記録して終了する"
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const payload = { id: path, path, title, content, contentHash: hash, syncUuid, deletedAt: null, expectedPreviousContent: null, allowRestore: false };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO notes (id, path, sync_uuid, title, content, content_hash, source_modified_at, imported_at, updated_at, tags_json, ai_allowed, sensitivity, review_state) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, '[]', 1, 'unknown', 'ready')").bind(path, path, syncUuid, title, content, hash, now, now),
    env.DB.prepare("INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, 'notes', ?, 'upsert', ?, 'pending', 0, ?, ?, ?)").bind(crypto.randomUUID(), path, JSON.stringify(payload), now, now, now),
    env.DB.prepare("UPDATE app_meta SET value = ?, updated_at = ? WHERE key = ?").bind(JSON.stringify({ path, syncUuid, contentHash: hash }), now, auditKey)
  ]);
  return { created: true, path, syncUuid };
}
export async function runBudgetSelfAudit(env, nowMs = Date.now()) {
  if (!env?.DB?.prepare) return { ok: false, skipped: "database_unavailable" };
  const now = utcTimestamp(nowMs);
  const day = now.slice(0, 10);
  const slot = Number(now.slice(11, 13)) < 12 ? "00" : "12";
  const key = `budget-audit:${day}:${slot}`;
  const cutoff = utcTimestamp(nowMs - 24 * 60 * 60 * 1000);

  let budget = null;
  let aiUsage = null;
  try {
    budget = await env.DB.prepare(
      "SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?"
    ).bind(day).first();
  } catch {
    // Old or partially migrated environments remain observable as unavailable.
  }
  // The audit is lower priority than admitted work. Skip it when the shared
  // Workflow reservation ledger is unavailable or has consumed 80% of its
  // application allocation; the audit never bypasses the normal budget gate.
  if (!budget) return { ok: true, recorded: false, skipped: "workflow_budget_unavailable" };
  if (Number(budget.workflow_steps_reserved || 0) >= 2160) {
    return { ok: true, recorded: false, skipped: "low_priority_budget_gate" };
  }
  try {
    aiUsage = await env.DB.prepare(
      "SELECT reserved_neurons, actual_neurons, calls_failed, calls_completed FROM workers_ai_daily_usage WHERE usage_day = ?"
    ).bind(day).first();
  } catch {
    // Do not interpret a missing migration as zero consumption.
  }

  const taskGroups = (await env.DB.prepare(`
    SELECT status, COUNT(*) AS count
    FROM agent_tasks
    WHERE created_at >= ?
    GROUP BY status
  `).bind(cutoff).all()).results || [];
  const errorGroups = (await env.DB.prepare(`
    SELECT last_error_class AS error_class, COUNT(*) AS count
    FROM agent_tasks
    WHERE created_at >= ? AND last_error_class IS NOT NULL AND last_error_class <> ''
    GROUP BY last_error_class
    ORDER BY count DESC
    LIMIT 10
  `).bind(cutoff).all()).results || [];

  const report = {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    period: { from: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(), to: new Date(nowMs).toISOString() },
    ...summarizeFindings({ budget, taskGroups, errorGroups, aiUsage }),
    limitations: [
      "Cloudflare account-wide Workers/D1/DO/Workflows usage is not attributed by this local D1 audit.",
      "GraphQL Analytics is not connected to the Worker; missing AI ledger data is reported as unavailable.",
      "This audit is read-only and does not create notes, tasks, branches, or pull requests.",
    ],
  };

  const saved = await env.DB.prepare(
    "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING"
  ).bind(key, JSON.stringify(report), now).run();
  if (Number(saved?.meta?.changes || 0) !== 1) return { ok: true, recorded: false, skipped: "slot_already_recorded", key, report };
  let improvement = { created: false, reason: "no_actionable_findings" };
  try { improvement = await createAuditImprovementRequest(env, report, nowMs); }
  catch { improvement = { created: false, reason: "improvement_request_creation_failed" }; }
  return { ok: true, recorded: true, key, report, improvement };
}

export { MAX_RUNS_PER_DAY, summarizeFindings };
