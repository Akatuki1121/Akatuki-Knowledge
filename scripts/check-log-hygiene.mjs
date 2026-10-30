import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Issue #63 の再発防止: 保存型ログへ本文・自由文字列・ID 配列が出る経路を戻さない。
// アプリ側のソースだけを対象にし、ベンダコード (Yjs / lib0) は行単位で除外する。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const outboxSource = await readFile(new URL("../src/sync-outbox.mjs", import.meta.url), "utf8");
const replyTextSource = await readFile(new URL("../src/reply-text.mjs", import.meta.url), "utf8");
const noteSearchTextSource = await readFile(new URL("../src/note-search-text.mjs", import.meta.url), "utf8");
const botAlertsSource = await readFile(new URL("../src/bot-alerts.mjs", import.meta.url), "utf8");
const taskPolicySource = await readFile(new URL("../src/background-task-policy.mjs", import.meta.url), "utf8");

for (const [name, source] of [["src/index.js", workerSource], ["src/sync-outbox.mjs", outboxSource]]) {
  assert.ok(!source.includes("String(error).slice(0, 200)"), `${name} must not log raw error strings`);
  assert.ok(!source.includes("error: result.error"), `${name} must not log upstream error text verbatim`);
  assert.ok(!source.includes("safeNoteIdRecovery: reconcile }"), `${name} must log the reconcile summary, not the full result`);
}

assert.ok(
  workerSource.includes('from "./log-sanitize.mjs"'),
  "the Worker entry point must use the shared log sanitizer"
);

// アプリ側の console.* は、固定のイベント名だけの出力 (分類 A のタイミングログ等) か、
// describeSafeFailure 経由の構造化出力を伴うものだけに限る。
const APP_CONSOLE_LINES = /console\.(?:log|error|warn)\(/u;
// 分類 D のベンダ行 (Yjs / lib0 の固定文字列) は対象外として列挙する。
const VENDOR_LOG_MARKERS = ["computeLoggingArgs", "[yjs]", "already integrated as a sub-document", "Yjs was already imported", "console.error(e);"];
for (const [name, source] of [["src/index.js", workerSource], ["src/sync-outbox.mjs", outboxSource], ["src/reply-text.mjs", replyTextSource], ["src/note-search-text.mjs", noteSearchTextSource], ["src/bot-alerts.mjs", botAlertsSource], ["src/background-task-policy.mjs", taskPolicySource]]) {
  source.split("\n").forEach((line, index) => {
    if (!APP_CONSOLE_LINES.test(line)) return;
    if (VENDOR_LOG_MARKERS.some((marker) => line.includes(marker))) return;
    assert.ok(
      line.includes("describeSafeFailure") || line.includes("describeOrganizeFailure") || line.includes("safeErrorCode") || line.includes("summarizeReconcile") || line.includes("operational_alert") || line.includes("agentTaskRecovery") || line.includes("budgetSelfAudit"),
      `${name}:${index + 1} logs without the shared sanitizer: ${line.trim().slice(0, 120)}`
    );
  });
}

console.log("Log hygiene checks passed.");
