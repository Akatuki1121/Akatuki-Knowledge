// 保管庫の整理自動化・段階1 (記録と分類だけ) の巡回と、app_meta 上の
// 状態 (カーソル・処理済みの印・日次集計) の読み書き。
// 設計: docs/VAULT_ORGANIZATION.md。件ごとの構造化記録 (R6) は新しい
// テーブルが要るため判断点 J5 に分け、段階1の前半はこの形で実測する。
//
// 巡回はノートを変更しない。書き込むのは app_meta だけである。
import {
  checkVaultNoteExclusion,
  classifyVaultNoteByRules,
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

function confidenceBucket(confidence) {
  const index = Math.min(CONFIDENCE_BUCKETS.length - 1, Math.max(0, Math.floor(confidence * 10)));
  return CONFIDENCE_BUCKETS[index];
}

/**
 * Notes/Inbox の巡回 (段階1: 分類と記録だけ)。
 * options.classifyWithAi は第1層の呼び出しで、{ title, contentHead } を
 * 受けて次のいずれかを返す注入関数。省略時は AI を呼ばない。
 *   { outcome: "decided", targetPath, confidence, reason, neurons }
 *   { outcome: "undecided", confidence (数値 or null), neurons }
 *   { outcome: "blocked", neurons }  材料に認証情報が検出され送らなかった
 *   { outcome: "error", neurons }    呼び出し自体の失敗
 */
export async function scanVaultOrganizationInbox(db, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const classifyWithAi = typeof options.classifyWithAi === "function" ? options.classifyWithAi : null;
  const startedAtMs = Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const delta = emptyVaultOrganizationStats();
  const notes = [];
  let blocked = false;
  let lastProcessed = null;

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

  for (const note of rows) {
    delta.scanned++;
    // 取得の失敗や同一性の欠けを「空のノート」と読み違えない (設計 F1)。
    // その回は扱わず、印も付けず、カーソルも進めない。
    if (typeof note.sync_uuid !== "string" || !note.sync_uuid
      || typeof note.content_hash !== "string" || !/^[a-f0-9]{64}$/i.test(note.content_hash)
      || typeof note.content !== "string") {
      delta.failed++;
      notes.push({ path: note.path, basisKind: "failed" });
      blocked = true;
      break;
    }
    const seenKey = await vaultOrganizationSeenKey(note.sync_uuid, note.content_hash);
    // 常時除外は本文を開く前に、パスと題だけで判定する。
    const exclusion = checkVaultNoteExclusion({ path: note.path, title: note.title });
    if (exclusion) {
      delta.excluded++;
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
      await markSeen(db, seenKey, nowMs);
      notes.push({ path: note.path, basisKind: "rule", ruleId: rule.ruleId, targetPath: rule.targetPath, stage: rule.stage });
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
      await markSeen(db, seenKey, nowMs);
      notes.push({ path: note.path, basisKind: "excluded", detail: "ai_material_credentials" });
      lastProcessed = note;
      continue;
    }
    if (aiOutcome?.outcome === "decided" && typeof aiOutcome.targetPath === "string") {
      delta.ai_decided++;
      await markSeen(db, seenKey, nowMs);
      notes.push({
        path: note.path, basisKind: "workers_ai", targetPath: aiOutcome.targetPath,
        stage: rule?.stage ?? 1, confidence: aiOutcome.confidence ?? null,
      });
      lastProcessed = note;
      continue;
    }
    delta.undecided++;
    delta.claude_pending++;
    await markSeen(db, seenKey, nowMs);
    notes.push({
      path: note.path, basisKind: "undecided",
      stage: rule?.stage ?? 0, detail: aiOutcome ? "ai_undecided" : "no_rule_match",
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
    aiNeurons: delta.ai_neurons,
    hasMore: !blocked && rows.length >= VAULT_ORGANIZATION_SCAN_LIMIT,
    notes,
  };
}
