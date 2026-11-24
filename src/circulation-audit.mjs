// 「待っているもの」の読み取り専用巡回監査。
// 閾値・対象ルートは将来 Notes 内のルールノートへ差し替える前提で、ここに集約する。
export const CIRCULATION_AUDIT_RULES = Object.freeze({
  stagnantDays: 14,
  pathlessAgedDays: 14,
  setRoots: Object.freeze([
    "Notes/Inbox/",
    "Notes/タスク/",
    "Notes/改善/",
    "Notes/AI共有/",
    "Notes/履歴/"
  ]),
  dailyRoots: Object.freeze([
    "Notes/Inbox/",
    "Notes/タスク/",
    "Notes/改善/",
    "Notes/AI共有/"
  ])
});

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_TABLES = Object.freeze(["audit_runs", "audit_findings", "audit_note_state"]);

function isLive(row) {
  return row && row.deleted_at == null;
}

function isUnderRoots(path, roots) {
  return typeof path === "string" && roots.some((root) => path.startsWith(root));
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return Date.parse(normalized);
}

function keyOf(source, noteId) {
  return source + "\u0000" + noteId;
}

export function enumerateCirculationSet({ notes = [], telegramNotes = [], identityReviews = [] }) {
  const reviewByPath = new Map();
  for (const review of identityReviews) {
    if (typeof review?.path === "string" && review.path) {
      const current = reviewByPath.get(review.path) ?? [];
      current.push({
        classification: review.classification ?? null,
        reason: review.reason ?? null,
        fileId: review.file_id ?? null
      });
      reviewByPath.set(review.path, current);
    }
  }

  const obsidian = notes
    .filter((row) => isLive(row) && isUnderRoots(row.path, CIRCULATION_AUDIT_RULES.setRoots))
    .map((row) => ({ ...row, source: "obsidian", note_id: row.note_id ?? row.id }));
  const telegram = telegramNotes
    .filter(isLive)
    .map((row) => ({ ...row, path: null, source: "telegram", note_id: row.note_id ?? row.id }));

  const all = [...obsidian, ...telegram];
  const patrol = all.filter((row) => row.source === "telegram" || isUnderRoots(row.path, CIRCULATION_AUDIT_RULES.dailyRoots));
  const quarantined = all.filter((row) => row.source === "obsidian" && reviewByPath.has(row.path));
  const patrolQuarantined = patrol.filter((row) => row.source === "obsidian" && reviewByPath.has(row.path));
  const quarantinedByKey = new Map(quarantined.map((row) => [keyOf(row.source, row.note_id), reviewByPath.get(row.path)]));
  return {
    all,
    patrol,
    quarantined,
    patrolQuarantined,
    effectivePatrol: patrol.filter((row) => !quarantinedByKey.has(keyOf(row.source, row.note_id))),
    reviewByPath,
    quarantinedByKey
  };
}

export function detectCirculationChanges(currentRows, previousRows) {
  const previous = new Map(previousRows.map((row) => [keyOf(row.source, row.note_id), row]));
  const current = new Map(currentRows.map((row) => [keyOf(row.source, row.note_id), row]));
  const added = [];
  const hashChanged = [];
  const setOut = [];

  for (const row of currentRows) {
    const old = previous.get(keyOf(row.source, row.note_id));
    if (!old) added.push(row);
    else if ((old.last_seen_hash ?? null) !== (row.content_hash ?? null)) hashChanged.push({ ...row, previousHash: old.last_seen_hash ?? null });
  }
  for (const old of previousRows) {
    if (!current.has(keyOf(old.source, old.note_id))) setOut.push(old);
  }
  return { added, hashChanged, setOut, changedCount: added.length + hashChanged.length + setOut.length };
}

export function buildCirculationAuditPlan({ notes = [], telegramNotes = [], identityReviews = [], previousState = [], now = Date.now() }) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid timestamp");
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - CIRCULATION_AUDIT_RULES.stagnantDays * DAY_MS;
  const pathlessCutoff = nowMs - CIRCULATION_AUDIT_RULES.pathlessAgedDays * DAY_MS;
  const cutoffIso = new Date(cutoff).toISOString();
  const set = enumerateCirculationSet({ notes, telegramNotes, identityReviews });
  const changes = detectCirculationChanges(set.all, previousState);
  const previousByKey = new Map(previousState.map((row) => [keyOf(row.source, row.note_id), row]));
  const changedKeys = new Set([
    ...changes.added.map((row) => keyOf(row.source, row.note_id)),
    ...changes.hashChanged.map((row) => keyOf(row.source, row.note_id))
  ]);
  const findings = [];

  for (const row of set.patrolQuarantined) {
    findings.push({
      source: row.source,
      note_id: row.note_id,
      path: row.path,
      kind: "quarantined_overlap",
      detail: { reviews: set.reviewByPath.get(row.path) ?? [] }
    });
  }

  for (const row of set.effectivePatrol) {
    const updatedAt = parseTimestamp(row.updated_at);
    if (row.source === "obsidian"
      && !changedKeys.has(keyOf(row.source, row.note_id))
      && Number.isFinite(updatedAt)
      && updatedAt < cutoff) {
      findings.push({
        source: row.source,
        note_id: row.note_id,
        path: row.path,
        kind: "stagnant",
        detail: { updated_at: row.updated_at, threshold_days: CIRCULATION_AUDIT_RULES.stagnantDays, content_hash: row.content_hash ?? null }
      });
    }
    if (row.source === "telegram" && Number.isFinite(updatedAt) && updatedAt < pathlessCutoff) {
      findings.push({
        source: row.source,
        note_id: row.note_id,
        path: null,
        kind: "pathless_aged",
        detail: { updated_at: row.updated_at, threshold_days: CIRCULATION_AUDIT_RULES.pathlessAgedDays }
      });
    }
  }

  for (const old of changes.setOut) {
    findings.push({
      source: old.source,
      note_id: old.note_id,
      path: old.last_path ?? old.path ?? null,
      kind: "set_out",
      detail: { last_seen_hash: old.last_seen_hash ?? null, first_seen_in_set_at: old.first_seen_in_set_at ?? null }
    });
  }

  const stateRows = set.all.map((row) => {
    const old = previousByKey.get(keyOf(row.source, row.note_id));
    return {
      source: row.source,
      note_id: row.note_id,
      last_seen_hash: row.content_hash ?? null,
      first_seen_in_set_at: old?.first_seen_in_set_at ?? nowIso,
      last_seen_at: nowIso,
      last_path: row.path ?? null
    };
  });

  return {
    ...set,
    changes,
    changedCount: changes.changedCount,
    findings,
    stateRows,
    cutoff: cutoffIso,
    effectivePatrolTotal: set.effectivePatrol.length
  };
}

async function runBatches(db, statements, batchSize = 50) {
  for (let index = 0; index < statements.length; index += batchSize) {
    await db.batch(statements.slice(index, index + batchSize));
  }
}

function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : "circulation_audit_failed";
}

function makeNotification({ startedAt, plan }) {
  const count = (kind) => plan.findings.filter((finding) => finding.kind === kind).length;
  const day = startedAt.slice(0, 10);
  return [
    "巡回監査 " + day,
    "集合 " + plan.all.length + "件／日次巡回 " + plan.patrol.length + "件／隔離 " + plan.quarantined.length + "件（実効 " + plan.effectivePatrolTotal + "件）",
    "変化 " + plan.changedCount + "件",
    "検出：滞留 " + count("stagnant") + "件、隔離重複 " + count("quarantined_overlap") + "件、パスなし滞留 " + count("pathless_aged") + "件、集合外 " + count("set_out") + "件"
  ].join("\n");
}

export async function runCirculationAudit(env, now = Date.now()) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: "database_unavailable" };

  let runId = null;
  let runStartedAt = new Date(now).toISOString();
  try {
    const tableResult = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)"
    ).bind(...REQUIRED_TABLES).all();
    const present = new Set((tableResult?.results ?? []).map((row) => row.name));
    if (REQUIRED_TABLES.some((name) => !present.has(name))) {
      console.log(JSON.stringify({ circulationAudit: { ok: false, skipped: "audit_tables_missing" } }));
      return { ok: false, skipped: "audit_tables_missing" };
    }

    runId = crypto.randomUUID();
    await db.prepare(
      "INSERT INTO audit_runs (id, started_at, ok, set_total, patrol_total, quarantined, changed_count, findings_count) VALUES (?, ?, 0, 0, 0, 0, 0, 0)"
    ).bind(runId, runStartedAt).run();

    const [notesResult, telegramResult, reviewsResult, stateResult] = await Promise.all([
      db.prepare(
        "SELECT id AS note_id, path, content_hash, updated_at, deleted_at FROM notes WHERE deleted_at IS NULL AND (path LIKE 'Notes/Inbox/%' OR path LIKE 'Notes/タスク/%' OR path LIKE 'Notes/改善/%' OR path LIKE 'Notes/AI共有/%' OR path LIKE 'Notes/履歴/%')"
      ).all(),
      db.prepare(
        "SELECT id AS note_id, content_hash, updated_at, deleted_at FROM telegram_notes WHERE deleted_at IS NULL"
      ).all(),
      db.prepare(
        "SELECT file_id, path, classification, reason FROM yaos_sync_identity_review"
      ).all(),
      db.prepare(
        "SELECT source, note_id, last_seen_hash, first_seen_in_set_at, last_seen_at, last_path FROM audit_note_state"
      ).all()
    ]);

    const plan = buildCirculationAuditPlan({
      notes: notesResult?.results ?? [],
      telegramNotes: telegramResult?.results ?? [],
      identityReviews: reviewsResult?.results ?? [],
      previousState: stateResult?.results ?? [],
      now: now
    });

    const createdAt = new Date(now).toISOString();
    const findingStatements = plan.findings.map((finding) => db.prepare(
      "INSERT INTO audit_findings (run_id, source, note_id, path, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(runId, finding.source, finding.note_id, finding.path, finding.kind, JSON.stringify(finding.detail), createdAt));

    const stateStatements = plan.stateRows.map((row) => db.prepare(
      "INSERT INTO audit_note_state (source, note_id, last_seen_hash, first_seen_in_set_at, last_seen_at, last_path) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, note_id) DO UPDATE SET last_seen_hash = excluded.last_seen_hash, last_seen_at = excluded.last_seen_at, last_path = excluded.last_path"
    ).bind(row.source, row.note_id, row.last_seen_hash, row.first_seen_in_set_at, row.last_seen_at, row.last_path));
    const setOutStatements = plan.changes.setOut.map((row) => db.prepare(
      "DELETE FROM audit_note_state WHERE source = ? AND note_id = ?"
    ).bind(row.source, row.note_id));

    await runBatches(db, [...findingStatements, ...stateStatements, ...setOutStatements]);
    const notificationText = makeNotification({ startedAt: runStartedAt, plan });
    await db.prepare(
      "UPDATE audit_runs SET finished_at = ?, ok = 1, set_total = ?, patrol_total = ?, quarantined = ?, changed_count = ?, findings_count = ?, notification_text = ?, error = NULL WHERE id = ?"
    ).bind(
      new Date().toISOString(),
      plan.all.length,
      plan.patrol.length,
      plan.quarantined.length,
      plan.changedCount,
      plan.findings.length,
      notificationText,
      runId
    ).run();

    const summary = {
      ok: true,
      runId,
      setTotal: plan.all.length,
      patrolTotal: plan.patrol.length,
      quarantined: plan.quarantined.length,
      effectivePatrolTotal: plan.effectivePatrolTotal,
      changedCount: plan.changedCount,
      findingsCount: plan.findings.length
    };
    console.log(JSON.stringify({ circulationAudit: summary }));
    return summary;
  } catch (error) {
    const errorCode = safeFailureCode(error);
    if (runId) {
      try {
        await db.prepare(
          "UPDATE audit_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?"
        ).bind(new Date().toISOString(), errorCode, runId).run();
      } catch {
        // Preserve the original audit failure; no note data is logged.
      }
    }
    console.error(JSON.stringify({ circulationAudit: { ok: false, error: errorCode } }));
    return { ok: false, runId, error: errorCode };
  }
}
