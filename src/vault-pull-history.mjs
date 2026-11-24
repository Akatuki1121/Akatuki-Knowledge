const DAY_MS = 24 * 60 * 60 * 1000;

function countOrNull(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

export function buildVaultPullRunRecord({ id, startedMs, finishedMs, finishedAt, result, error, errorCode }) {
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs)
    ? Math.max(0, Math.floor(finishedMs - startedMs))
    : null;
  const stage = typeof result?.stage === "string" && /^[a-z_]{1,40}$/.test(result.stage)
    ? result.stage
    : error
      ? "pull"
      : result?.error
        ? "apply_sync"
        : null;

  return {
    id,
    finishedAt,
    durationMs,
    ok: !error && result?.ok === true && !result?.error ? 1 : 0,
    stage,
    errorCode: typeof errorCode === "string" ? errorCode : null,
    queued: countOrNull(result?.queued),
    created: countOrNull(result?.created),
    updated: countOrNull(result?.updated),
    vaultFiles: countOrNull(result?.vaultFiles)
  };
}

export function buildVaultPullChangeRows(runId, changes) {
  if (!Number.isFinite(runId) || runId < 1 || !Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    if (!change || typeof change.path !== "string" || !change.path.trim()
      || typeof change.appliedAt !== "string" || !change.appliedAt) return [];
    return [{
      runId,
      path: change.path,
      sourceModifiedAt: typeof change.sourceModifiedAt === "string" ? change.sourceModifiedAt.slice(0, 64) : null,
      appliedAt: change.appliedAt
    }];
  });
}

export function getVaultPullRetentionCutoffs(nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    runsBefore: new Date(now - 30 * DAY_MS).toISOString(),
    changesBefore: new Date(now - 180 * DAY_MS).toISOString()
  };
}
