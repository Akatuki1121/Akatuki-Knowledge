// 保管庫の整理自動化の巡回と、状態 (app_meta のカーソル・処理済みの印・
// 日次集計) と件ごとの構造化記録 (vault_organization_records) の読み書き。
// 設計: docs/VAULT_ORGANIZATION.md。
//
// 段階1は分類と記録だけ。段階2では、記録テーブルが実在し、件ごとの
// 記録が書ける場合に限り、規則で決まった段1の移動と、段2の空白の
// 正規化だけを実行する。実行そのものは注入された executor (index.js
// 側で公開 API の経路を内部呼び出しする) に委ね、このモジュールは
// ノートを直接変更しない。記録テーブルが無い間は、段階1の挙動
// (分類と集計だけ) に倒れる。
import {
  checkVaultNoteExclusion,
  classifyVaultNoteByRules,
  isWhitespaceOnlyChange,
  normalizeVaultNoteWhitespace,
  VAULT_ORGANIZATION_AI_HEAD_CHARS,
  VAULT_ORGANIZATION_RULE_HEAD_CHARS,
} from "./vault-organization-rules.mjs";

// R7 の上限と猶予の初期値 (段階1の実測で置き換える前提)。
export const VAULT_ORGANIZATION_SCAN_LIMIT = 10;
export const VAULT_ORGANIZATION_AI_CALLS_PER_RUN = 10;
export const VAULT_ORGANIZATION_AI_CALLS_PER_DAY = 30;
export const VAULT_ORGANIZATION_GRACE_MS = 2 * 60 * 60 * 1000;

const CURSOR_KEY = "vault_organization_cursor";
const STATS_KEY_PREFIX = "vault_organization_stats:";
const SEEN_KEY_PREFIX = "vault_organization_seen:";
const CONFIDENCE_BUCKETS = Object.freeze([
  "0.0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9",
]);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 処理済みの印のキー。材料と作り方は改善の巡回 (improvementSeenKey) と
// 同じで、本文が変わればキーが変わり、再分類の対象になる。
export async function vaultOrganizationSeenKey(syncUuid, contentHash) {
  return SEEN_KEY_PREFIX + await sha256Hex(syncUuid + ":" + contentHash);
}

async function getAppMeta(db, key) {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(key).first();
  return typeof row?.value === "string" ? row.value : null;
}

async function setAppMeta(db, key, value, nowMs) {
  const now = new Date(nowMs).toISOString();
  await db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, now).run();
}

async function deleteAppMeta(db, key) {
  await db.prepare("DELETE FROM app_meta WHERE key = ?").bind(key).run();
}

export async function readVaultOrganizationCursor(db) {
  const raw = await getAppMeta(db, CURSOR_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.updatedAt === "string" && typeof parsed?.id === "string"
      ? { updatedAt: parsed.updatedAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function emptyVaultOrganizationStats() {
  return {
    scanned: 0,
    excluded: 0,
    deferred: 0,
    failed: 0,
    rule_decided: 0,
    ai_called: 0,
    ai_decided: 0,
    undecided: 0,
    claude_pending: 0,
    moved: 0,
    formatted: 0,
    execution_failed: 0,
    ai_neurons: 0,
    confidence_buckets: Object.fromEntries(CONFIDENCE_BUCKETS.map((bucket) => [bucket, 0])),
    runs: 0,
    duration_ms_total: 0,
    processed_total: 0,
  };
}

function normalizeStats(raw) {
  const stats = emptyVaultOrganizationStats();
  if (!raw || typeof raw !== "object") return stats;
  for (const key of Object.keys(stats)) {
    if (key === "confidence_buckets") continue;
    if (Number.isFinite(raw[key]) && raw[key] >= 0) stats[key] = Math.floor(raw[key]);
  }
  if (raw.confidence_buckets && typeof raw.confidence_buckets === "object") {
    for (const bucket of CONFIDENCE_BUCKETS) {
      const value = raw.confidence_buckets[bucket];
      if (Number.isFinite(value) && value >= 0) stats.confidence_buckets[bucket] = Math.floor(value);
    }
  }
  return stats;
}

export async function readVaultOrganizationStats(db, day) {
  const raw = await getAppMeta(db, STATS_KEY_PREFIX + day);
  if (!raw) return emptyVaultOrganizationStats();
  try {
    return normalizeStats(JSON.parse(raw));
  } catch {
    return emptyVaultOrganizationStats();
  }
}

async function isSeen(db, seenKey) {
  const row = await db.prepare("SELECT key FROM app_meta WHERE key = ?").bind(seenKey).first();
  return Boolean(row);
}

async function markSeen(db, seenKey, nowMs) {
  await setAppMeta(db, seenKey, "1", nowMs);
}

// notes.updated_at は SQLite の日時文字列 (UTC) で、ISO 形も混ざりうる。
// 読めない場合は null を返し、呼び出し側は猶予中として倒す (書いてから
// 間もないノートには触らない、という性質6側の安全側)。
function parseNoteUpdatedAtMs(value) {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// 件ごとの構造化記録 (R6) の置き場所。マイグレーション
// migrations/pending/0020_vault_organization_records.sql で用意し、
// 適用は人間の手順で行う。適用が済むまではテーブルが実在しない。
export const VAULT_ORGANIZATION_RECORDS_TABLE = "vault_organization_records";

// 記録の basis_kind の固定の語彙 (仕様書 §2.3)。
export const VAULT_ORGANIZATION_BASIS_KINDS = Object.freeze([
  "excluded",
  "grace",
  "rule",
  "workers_ai",
  "claude_pending",
  "undecided",
]);

// テーブルが実在するかを、巡回ごとに1回だけ安く確かめる。
// 実在しない (未適用) 間は false を返し、巡回は記録なしに倒れる。
export async function vaultOrganizationRecordsAvailable(db) {
  try {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(VAULT_ORGANIZATION_RECORDS_TABLE).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function insertVaultOrganizationRecord(db, record, nowMs) {
  await db.prepare(`
    INSERT INTO ${VAULT_ORGANIZATION_RECORDS_TABLE}
      (note_id, sync_uuid, path, content_hash_before, content_hash_after,
       stage, action, basis_kind, basis_detail, target_path, confidence,
       outcome, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.noteId,
    record.syncUuid ?? null,
    record.path,
    record.contentHashBefore ?? null,
    record.contentHashAfter ?? null,
    record.stage,
    record.action,
    record.basisKind,
    record.basisDetail ? JSON.stringify(record.basisDetail) : null,
    record.targetPath ?? null,
    typeof record.confidence === "number" && Number.isFinite(record.confidence) ? record.confidence : null,
    record.outcome,
    JSON.stringify(record.detail ?? {}),
    new Date(nowMs).toISOString(),
  ).run();
}

// 読み口 (GET /api/organization/records) の裏側。テーブルが無い間は
// null を返し、呼び出し側は「記録はまだ無い」として応答する。
export async function listVaultOrganizationRecords(db, filters = {}) {
  if (!await vaultOrganizationRecordsAvailable(db)) return null;
  const conditions = [];
  const binds = [];
  if (typeof filters.since === "string" && filters.since) {
    conditions.push("created_at >= ?");
    binds.push(filters.since);
  }
  if (typeof filters.until === "string" && filters.until) {
    conditions.push("created_at <= ?");
    binds.push(filters.until);
  }
  if (typeof filters.basisKind === "string" && filters.basisKind) {
    conditions.push("basis_kind = ?");
    binds.push(filters.basisKind);
  }
  if (typeof filters.action === "string" && filters.action) {
    conditions.push("action = ?");
    binds.push(filters.action);
  }
  const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(100, Math.floor(filters.limit))) : 20;
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const rows = (await db.prepare(`
    SELECT record_id, note_id, sync_uuid, path, content_hash_before, content_hash_after,
           stage, action, basis_kind, basis_detail, target_path, confidence,
           outcome, detail_json, created_at
    FROM ${VAULT_ORGANIZATION_RECORDS_TABLE}${where}
    ORDER BY created_at DESC, record_id DESC
    LIMIT ?
  `).bind(...binds, limit).all()).results || [];
  const parseJson = (value, fallback) => {
    if (typeof value !== "string" || !value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  return rows.map((row) => ({
    ...row,
    basis_detail: parseJson(row.basis_detail, null),
    detail_json: parseJson(row.detail_json, {}),
  }));
}

function confidenceBucket(confidence) {
  const index = Math.min(CONFIDENCE_BUCKETS.length - 1, Math.max(0, Math.floor(confidence * 10)));
  return CONFIDENCE_BUCKETS[index];
}

/**
 * Notes/Inbox の巡回。
 * options.classifyWithAi は第1層の呼び出しで、{ title, contentHead } を
 * 受けて次のいずれかを返す注入関数。省略時は AI を呼ばない。
 *   { outcome: "decided", targetPath, confidence, reason, neurons }
 *   { outcome: "undecided", confidence (数値 or null), neurons }
 *   { outcome: "blocked", neurons }  材料に認証情報が検出され送らなかった
 *   { outcome: "error", neurons }    呼び出し自体の失敗
 *
 * 段階2の実行は、記録テーブルが実在し、そのノートの分類の記録が
 * 書けた場合に限る。options.executeMove / options.executeFormat は
 * index.js 側の注入関数で、それぞれ次を返す。
 *   executeMove:   { outcome: "moved", contentHash } | { outcome: "failed", error }
 *   executeFormat: { outcome: "formatted", contentHashAfter }
 *                | { outcome: "unchanged" } | { outcome: "failed", error }
 * executeMove は規則 (第0層) で宛先が決まった段1だけに呼び、AI の分類
 * だけで決まった段1には呼ばない。executeFormat は K4 (段2候補) の
 * ノートにだけ呼び、操作は空白の正規化に限る。
 */
export async function scanVaultOrganizationInbox(db, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const classifyWithAi = typeof options.classifyWithAi === "function" ? options.classifyWithAi : null;
  const executeMove = typeof options.executeMove === "function" ? options.executeMove : null;
  const executeFormat = typeof options.executeFormat === "function" ? options.executeFormat : null;
  const startedAtMs = Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const delta = emptyVaultOrganizationStats();
  const notes = [];
  let blocked = false;
  let lastProcessed = null;

  // 記録テーブルの有無は巡回ごとに1回だけ確かめる。書込みに失敗したら
  // その回は以後を記録なしに倒し、実行も止める。
  const recordsTablePresent = await vaultOrganizationRecordsAvailable(db);
  let recordsAvailable = recordsTablePresent;
  const writeRecord = async (record) => {
    if (!recordsAvailable) return false;
    try {
      await insertVaultOrganizationRecord(db, record, nowMs);
      return true;
    } catch {
      recordsAvailable = false;
      return false;
    }
  };
  const classifyRecord = (note, fields) => ({
    noteId: note.id,
    syncUuid: typeof note.sync_uuid === "string" ? note.sync_uuid : null,
    path: note.path,
    contentHashBefore: typeof note.content_hash === "string" ? note.content_hash : null,
    contentHashAfter: typeof note.content_hash === "string" ? note.content_hash : null,
    confidence: null,
    targetPath: null,
    basisDetail: null,
    detail: {},
    ...fields,
  });

  const priorStats = await readVaultOrganizationStats(db, day);
  const cursor = await readVaultOrganizationCursor(db);
  const rows = (await db.prepare(`
    SELECT id, path, title, content, content_hash, sync_uuid, updated_at
    FROM notes
    WHERE path LIKE 'Notes/Inbox/%'
      AND deleted_at IS NULL
      AND (? IS NULL OR updated_at > ? OR (updated_at = ? AND id > ?))
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).bind(cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.id ?? "", VAULT_ORGANIZATION_SCAN_LIMIT).all()).results || [];

  // 段2の整形 (空白の正規化) の実行。K4 で段2候補になったノートにだけ
  // 呼ぶ。正規化が空白の範囲を出る場合は実行せず失敗として記録する (R4)。
  const attemptFormat = async (note, classifyRecorded) => {
    if (!classifyRecorded || !executeFormat) return null;
    const normalized = normalizeVaultNoteWhitespace(note.content);
    if (normalized === note.content) return null;
    const recordBase = {
      noteId: note.id,
      syncUuid: note.sync_uuid,
      path: note.path,
      contentHashBefore: note.content_hash,
      stage: 2,
      action: "format",
      basisKind: "rule",
      basisDetail: { ruleId: "K4" },
      targetPath: note.path,
      confidence: null,
    };
    if (!isWhitespaceOnlyChange(note.content, normalized)) {
      delta.execution_failed++;
      await writeRecord({
        ...recordBase,
        contentHashAfter: note.content_hash,
        outcome: "failed",
        detail: { error: "format_check_failed" },
      });
      return { action: "format", outcome: "failed", error: "format_check_failed" };
    }
    const exec = await Promise.resolve()
      .then(() => executeFormat({
        noteId: note.id,
        path: note.path,
        content: normalized,
        expectedContent: note.content,
        expectedContentHash: note.content_hash,
      }))
      .catch(() => ({ outcome: "failed", error: "executor_error" }));
    if (exec?.outcome === "formatted") {
      delta.formatted++;
      await writeRecord({
        ...recordBase,
        contentHashAfter: typeof exec.contentHashAfter === "string" ? exec.contentHashAfter : null,
        outcome: "recorded",
        detail: { error: null, verified: true },
      });
      return { action: "format", outcome: "formatted" };
    }
    if (exec?.outcome === "unchanged") {
      return { action: "format", outcome: "unchanged" };
    }
    delta.execution_failed++;
    await writeRecord({
      ...recordBase,
      contentHashAfter: note.content_hash,
      outcome: "failed",
      detail: { error: typeof exec?.error === "string" ? exec.error : "format_failed" },
    });
    return { action: "format", outcome: "failed", error: typeof exec?.error === "string" ? exec.error : "format_failed" };
  };

  for (const note of rows) {
    delta.scanned++;
    // 取得の失敗や同一性の欠けを「空のノート」と読み違えない (設計 F1)。
    // その回は扱わず、印も付けず、カーソルも進めない。
    if (typeof note.sync_uuid !== "string" || !note.sync_uuid
      || typeof note.content_hash !== "string" || !/^[a-f0-9]{64}$/i.test(note.content_hash)
      || typeof note.content !== "string") {
      delta.failed++;
      await writeRecord(classifyRecord(note, {
        stage: 0, action: "classify", basisKind: "undecided",
        outcome: "failed", detail: { reason: "integrity_check_failed" },
      }));
      notes.push({ path: note.path, basisKind: "failed" });
      blocked = true;
      break;
    }
    const seenKey = await vaultOrganizationSeenKey(note.sync_uuid, note.content_hash);
    // 常時除外は本文を開く前に、パスと題だけで判定する。
    const exclusion = checkVaultNoteExclusion({ path: note.path, title: note.title });
    if (exclusion) {
      delta.excluded++;
      await writeRecord(classifyRecord(note, {
        stage: 0, action: "classify", basisKind: "excluded",
        basisDetail: { ruleId: exclusion.ruleId }, outcome: "recorded",
      }));
      await markSeen(db, seenKey, nowMs);
      notes.push({ path: note.path, basisKind: "excluded", ruleId: exclusion.ruleId });
      lastProcessed = note;
      continue;
    }
    // 猶予: 更新から猶予時間が経っていないノートはその回は分類せず、
    // カーソルをその手前で止めて次回に必ず再走査されるようにする。
    const updatedAtMs = parseNoteUpdatedAtMs(note.updated_at);
    if (updatedAtMs === null || nowMs - updatedAtMs < VAULT_ORGANIZATION_GRACE_MS) {
      delta.deferred++;
      await writeRecord(classifyRecord(note, {
        stage: 0, action: "classify", basisKind: "grace", outcome: "deferred",
      }));
      notes.push({ path: note.path, basisKind: "grace" });
      blocked = true;
      break;
    }
    if (await isSeen(db, seenKey)) {
      lastProcessed = note;
      continue;
    }
    // 空の本文そのものは、空であることを記録して段0にする。
    if (!note.content.trim()) {
      delta.undecided++;
      delta.claude_pending++;
      await writeRecord(classifyRecord(note, {
        stage: 0, action: "classify", basisKind: "undecided",
        basisDetail: { reason: "empty_content" }, outcome: "recorded",
      }));
      await markSeen(db, seenKey, nowMs);
      notes.push({ path: note.path, basisKind: "undecided", detail: "empty_content" });
      lastProcessed = note;
      continue;
    }
    const rule = classifyVaultNoteByRules({
      title: note.title,
      contentHead: note.content.slice(0, VAULT_ORGANIZATION_RULE_HEAD_CHARS),
    });
    if (rule?.targetFolder) {
      delta.rule_decided++;
      const recorded = await writeRecord(classifyRecord(note, {
        stage: rule.stage, action: "classify", basisKind: "rule",
        basisDetail: { ruleId: rule.ruleId }, targetPath: rule.targetPath,
        outcome: "recorded",
      }));
      // 段1の移動は、規則で決まり、記録が書けた場合だけ実行する。
      let execution = null;
      if (recorded && executeMove) {
        const destinationPath = rule.targetPath + "/" + note.path.split("/").pop();
        const exec = await Promise.resolve()
          .then(() => executeMove({
            noteId: note.id,
            sourcePath: note.path,
            targetPath: destinationPath,
            expectedContentHash: note.content_hash,
            syncUuid: note.sync_uuid,
          }))
          .catch(() => ({ outcome: "failed", error: "executor_error" }));
        if (exec?.outcome === "moved") {
          delta.moved++;
          execution = { action: "move", outcome: "moved" };
        } else {
          delta.execution_failed++;
          execution = {
            action: "move", outcome: "failed",
            error: typeof exec?.error === "string" ? exec.error : "move_failed",
          };
        }
        await writeRecord({
          noteId: note.id,
          syncUuid: note.sync_uuid,
          path: note.path,
          contentHashBefore: note.content_hash,
          contentHashAfter: exec?.outcome === "moved" && typeof exec.contentHash === "string"
            ? exec.contentHash : note.content_hash,
          stage: rule.stage,
          action: "move",
          basisKind: "rule",
          basisDetail: { ruleId: rule.ruleId },
          targetPath: destinationPath,
          confidence: null,
          outcome: exec?.outcome === "moved" ? "recorded" : "failed",
          detail: { error: execution.error ?? null, identityVerified: exec?.outcome === "moved" },
        });
      }
      await markSeen(db, seenKey, nowMs);
      notes.push({
        path: note.path, basisKind: "rule", ruleId: rule.ruleId,
        targetPath: rule.targetPath, stage: rule.stage, execution,
      });
      lastProcessed = note;
      continue;
    }
    let aiOutcome = null;
    const aiCallsToday = priorStats.ai_called + delta.ai_called;
    if (classifyWithAi
      && delta.ai_called < VAULT_ORGANIZATION_AI_CALLS_PER_RUN
      && aiCallsToday < VAULT_ORGANIZATION_AI_CALLS_PER_DAY) {
      delta.ai_called++;
      try {
        aiOutcome = await classifyWithAi({
          title: note.title,
          contentHead: note.content.slice(0, VAULT_ORGANIZATION_AI_HEAD_CHARS),
        });
      } catch {
        aiOutcome = { outcome: "error", neurons: 0 };
      }
      if (Number.isFinite(aiOutcome?.neurons) && aiOutcome.neurons > 0) {
        delta.ai_neurons += Math.floor(aiOutcome.neurons);
      }
      if (typeof aiOutcome?.confidence === "number" && Number.isFinite(aiOutcome.confidence)) {
        delta.confidence_buckets[confidenceBucket(aiOutcome.confidence)]++;
      }
    }
    if (aiOutcome?.outcome === "blocked") {
      // 送信直前の伏字で認証情報が検出された材料は、AI へ送らず
      // 除外寄りの記録にする。
      delta.excluded++;
      await writeRecord(classifyRecord(note, {
        stage: 0, action: "classify", basisKind: "excluded",
        basisDetail: { reason: "ai_material_credentials" }, outcome: "recorded",
      }));
      await markSeen(db, seenKey, nowMs);
      notes.push({ path: note.path, basisKind: "excluded", detail: "ai_material_credentials" });
      lastProcessed = note;
      continue;
    }
    if (aiOutcome?.outcome === "decided" && typeof aiOutcome.targetPath === "string") {
      delta.ai_decided++;
      const recorded = await writeRecord(classifyRecord(note, {
        stage: rule?.stage ?? 1, action: "classify", basisKind: "workers_ai",
        basisDetail: { reason: typeof aiOutcome.reason === "string" ? aiOutcome.reason : null },
        targetPath: aiOutcome.targetPath,
        confidence: typeof aiOutcome.confidence === "number" ? aiOutcome.confidence : null,
        outcome: "recorded",
      }));
      await markSeen(db, seenKey, nowMs);
      // AI の分類だけで決まった段1は実行しない (案の側に留める)。
      // K4 で段2候補になったノートは、空白の正規化だけ実行しうる。
      const execution = rule?.ruleId === "K4" ? await attemptFormat(note, recorded) : null;
      notes.push({
        path: note.path, basisKind: "workers_ai", targetPath: aiOutcome.targetPath,
        stage: rule?.stage ?? 1, confidence: aiOutcome.confidence ?? null, execution,
      });
      lastProcessed = note;
      continue;
    }
    delta.undecided++;
    delta.claude_pending++;
    const recorded = await writeRecord(classifyRecord(note, {
      stage: rule?.stage ?? 0, action: "classify", basisKind: "claude_pending",
      basisDetail: { reason: aiOutcome ? "ai_undecided" : "no_rule_match" },
      outcome: "recorded",
    }));
    await markSeen(db, seenKey, nowMs);
    const execution = rule?.ruleId === "K4" ? await attemptFormat(note, recorded) : null;
    notes.push({
      path: note.path, basisKind: "undecided",
      stage: rule?.stage ?? 0, detail: aiOutcome ? "ai_undecided" : "no_rule_match",
      execution,
    });
    lastProcessed = note;
  }

  if (!blocked && rows.length >= VAULT_ORGANIZATION_SCAN_LIMIT && lastProcessed) {
    await setAppMeta(db, CURSOR_KEY, JSON.stringify({ updatedAt: lastProcessed.updated_at, id: lastProcessed.id }), nowMs);
  } else if (!blocked) {
    // 一覧の最後まで届いたらカーソルを戻し、次回は先頭から (印で
    // 処理済みを飛ばす) 再走査する。
    await deleteAppMeta(db, CURSOR_KEY);
  } else if (lastProcessed) {
    await setAppMeta(db, CURSOR_KEY, JSON.stringify({ updatedAt: lastProcessed.updated_at, id: lastProcessed.id }), nowMs);
  }

  delta.runs = 1;
  delta.duration_ms_total = Math.max(0, Date.now() - startedAtMs);
  delta.processed_total = delta.excluded + delta.rule_decided + delta.ai_decided + delta.undecided;
  const merged = normalizeStats(null);
  for (const key of Object.keys(merged)) {
    if (key === "confidence_buckets") continue;
    merged[key] = priorStats[key] + delta[key];
  }
  for (const bucket of CONFIDENCE_BUCKETS) {
    merged.confidence_buckets[bucket] = priorStats.confidence_buckets[bucket] + delta.confidence_buckets[bucket];
  }
  await setAppMeta(db, STATS_KEY_PREFIX + day, JSON.stringify(merged), nowMs);

  return {
    scanned: delta.scanned,
    excluded: delta.excluded,
    deferred: delta.deferred,
    failed: delta.failed,
    ruleDecided: delta.rule_decided,
    aiCalled: delta.ai_called,
    aiDecided: delta.ai_decided,
    undecided: delta.undecided,
    claudePending: delta.claude_pending,
    moved: delta.moved,
    formatted: delta.formatted,
    executionFailed: delta.execution_failed,
    recordsAvailable: recordsTablePresent,
    aiNeurons: delta.ai_neurons,
    hasMore: !blocked && rows.length >= VAULT_ORGANIZATION_SCAN_LIMIT,
    notes,
  };
}
