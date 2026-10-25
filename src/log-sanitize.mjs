// 保存型ログ向けの共通サニタイザ (Issue #63)。
// 方針: 出すのは「分類と数値」だけ。本文・自由文字列・ID 配列は出さない。
// src/organize.mjs の describeOrganizeFailure が使っていた許可フィールド方式を
// 汎用化したもので、エラーオブジェクトからは分類コードと数値ステータスだけを取り出す。
// error.message の原文は、既知の固定文言を列挙値 (reason) へ写す場合を除き、決して含めない。

const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:\-.]{0,39}$/u;

// 運用アラートの分類コード (classifyOperationalFailure / enqueueBotAlert と同じ語彙)。
export function classifyOperationalFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/429|quota|resource.?exhausted|rate.?limit|daily.?limit|制限|上限/iu.test(message)) return "gemini_limit";
  if (/GEMINI_API_KEY|not configured|configuration/iu.test(message)) return "configuration";
  return "processing_failure";
}

function safeCode(value) {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value) ? value : void 0;
}

// 既知の固定文言だけを列挙値へ写す。それ以外の自由文字列は reason にしない。
function failureReason(error) {
  const message = String(error?.message || "");
  if (message === "Gemini returned no text") return "empty_response";
  if (message === "AI response did not contain JSON") return "no_json";
  if (error instanceof SyntaxError) return "invalid_json";
  return void 0;
}

// 呼び出し側が渡す追加フィールドの許可リスト。
// 文字列は分類コード形式のものだけ、数値・真偽値はそのまま通す。配列・オブジェクトは捨てる。
const EXTRA_STRING_FIELDS = new Set(["stage", "source", "result"]);
const EXTRA_NUMBER_FIELDS = new Set([
  "noteCount", "promptChars", "contextMs", "searchMs", "generationMs", "answerMs",
  "queueWaitMs", "extractionMs", "saveMs", "totalMs", "dispatched", "deferred", "sent"
]);

export function describeSafeFailure(event, error, extra = {}) {
  const message = String(error?.message || "");
  const described = {
    event: safeCode(event) || "failure",
    kind: classifyOperationalFailure(error),
    errorName: typeof error?.name === "string" ? safeCode(error.name) || "Error" : "Error",
    httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : void 0,
    apiStatus: typeof error?.apiStatus === "string" ? error.apiStatus.slice(0, 40) : void 0,
    sqlite: message.match(/SQLITE_[A-Z_]+/)?.[0],
    reason: failureReason(error)
  };
  for (const [key, value] of Object.entries(extra || {})) {
    if (EXTRA_STRING_FIELDS.has(key)) {
      const code = safeCode(value);
      if (code) described[key] = code;
    } else if (EXTRA_NUMBER_FIELDS.has(key) && Number.isFinite(value)) {
      described[key] = value;
    }
  }
  return described;
}

// 上流が返す自由文字列のエラー値を、保存ログ向けの分類コードへ落とす。
// status_<番号> や小文字コード形式の既知の値だけを通し、それ以外は upstream_error にする。
export function safeErrorCode(value) {
  if (typeof value !== "string") return void 0;
  if (/^status_\d{3}$/u.test(value)) return value;
  return safeCode(value) || "upstream_error";
}

// reconcile 結果の保存ログ向け要約。件数と真偽値だけを残し、
// missingNoteIds のような ID 配列は件数へ置き換え、error は分類コードへ落とす。
const RECONCILE_COUNT_FIELDS = new Set([
  "scanned", "vaultFiles", "matched", "changed", "verified", "d1Updated", "alreadyAligned",
  "d1FrontmatterMissing", "missingInVault", "tombstonedInVault", "uuidPathMismatch",
  "unsafeMissingPaths", "duplicatePaths", "contentConflicts", "uuidConflicts",
  "queuedForRestore", "restoreQueueErrors", "skippedExistingJobs", "restoreSent", "restoreFailed"
]);

export function summarizeReconcile(result) {
  if (!result || typeof result !== "object") return { ok: false };
  const summary = {};
  if (typeof result.ok === "boolean") summary.ok = result.ok;
  const skipped = safeCode(result.skipped);
  if (skipped) summary.skipped = skipped;
  for (const key of RECONCILE_COUNT_FIELDS) {
    if (Number.isFinite(result[key])) summary[key] = result[key];
  }
  if (Array.isArray(result.missingNoteIds)) summary.missingNoteIdCount = result.missingNoteIds.length;
  if (result.error !== void 0) summary.errorCode = safeErrorCode(result.error);
  return summary;
}

// telegram-missing-id 分類結果の保存ログ向け要約。件数と真偽値だけを残し、
// skipped のようなパスを含む配列は件数へ置き換え、error は分類コードへ落とす。
const MISSING_ID_COUNT_FIELDS = new Set([
  "scanned", "alreadyHasId", "candidates", "selected", "backfilledCount", "verified"
]);

export function summarizeTelegramMissingId(result) {
  if (!result || typeof result !== "object") return { ok: false };
  const summary = {};
  if (typeof result.ok === "boolean") summary.ok = result.ok;
  if (typeof result.dryRun === "boolean") summary.dryRun = result.dryRun;
  if (typeof result.applied === "boolean") summary.applied = result.applied;
  for (const key of MISSING_ID_COUNT_FIELDS) {
    if (Number.isFinite(result[key])) summary[key] = result[key];
  }
  if (Array.isArray(result.skipped)) summary.skipped = result.skipped.length;
  if (Array.isArray(result.unverified)) summary.unverified = result.unverified.length;
  if (Array.isArray(result.rejected)) summary.rejected = result.rejected.length;
  if (result.error !== void 0) summary.errorCode = safeErrorCode(result.error);
  return summary;
}
