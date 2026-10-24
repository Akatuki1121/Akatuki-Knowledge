import test from "node:test";
import assert from "node:assert/strict";
import { describeSafeFailure, safeErrorCode, summarizeReconcile } from "../src/log-sanitize.mjs";

test("safe failure keeps classification fields but never the error message", () => {
  const error = new Error("quota exceeded for note body: 個人メモの本文 https://example.com/secret-path");
  error.httpStatus = 429;
  error.apiStatus = "RESOURCE_EXHAUSTED";
  const logged = JSON.stringify(describeSafeFailure("telegram_chat_response_failed", error));
  assert.ok(logged.includes('"event":"telegram_chat_response_failed"'));
  assert.ok(logged.includes('"kind":"gemini_limit"'));
  assert.ok(logged.includes('"httpStatus":429'));
  assert.ok(logged.includes('"apiStatus":"RESOURCE_EXHAUSTED"'));
  assert.ok(!logged.includes("個人メモ"), "note content must not be logged");
  assert.ok(!logged.includes("secret-path"), "URLs from error messages must not be logged");
});

test("safe failure extracts only the SQLite code from an error message", () => {
  const described = describeSafeFailure("agent_memory_job_failed", new Error("failed: SQLITE_CONSTRAINT_UNIQUE on a private note title"));
  assert.equal(described.sqlite, "SQLITE_CONSTRAINT_UNIQUE");
  assert.ok(!JSON.stringify(described).includes("private note"));
});

test("safe failure maps only known fixed messages to a reason", () => {
  assert.equal(describeSafeFailure("organize_failed", new Error("Gemini returned no text")).reason, "empty_response");
  assert.equal(describeSafeFailure("organize_failed", new Error("AI response did not contain JSON")).reason, "no_json");
  assert.equal(describeSafeFailure("organize_failed", new SyntaxError("Unexpected token 秘密")).reason, "invalid_json");
  assert.equal(describeSafeFailure("organize_failed", new Error("some free-form upstream sentence")).reason, void 0);
});

test("safe failure drops non-allowlisted extras and free-form strings", () => {
  const described = describeSafeFailure("vault_pull_failed", new Error("boom"), {
    stage: "read_vault",
    noteCount: 3,
    error: "raw upstream sentence",
    path: "/home/user/private",
    ids: [1, 2, 3]
  });
  assert.equal(described.stage, "read_vault");
  assert.equal(described.noteCount, 3);
  assert.equal(described.error, void 0);
  assert.equal(described.path, void 0);
  assert.equal(described.ids, void 0);
});

test("safe error code keeps known codes and replaces free-form upstream text", () => {
  assert.equal(safeErrorCode("status_502"), "status_502");
  assert.equal(safeErrorCode("vault_content_conflict"), "vault_content_conflict");
  assert.equal(safeErrorCode("Vault responded with a private sentence"), "upstream_error");
  assert.equal(safeErrorCode(void 0), void 0);
});

test("reconcile summary keeps counts, replaces the ID list with a count, and codes the error", () => {
  const summary = summarizeReconcile({
    ok: false,
    scanned: 10,
    changed: 2,
    missingInVault: 3,
    missingNoteIds: ["note-a", "note-b", "note-c"],
    contentConflicts: 1,
    error: "free-form upstream detail"
  });
  assert.deepEqual(summary, {
    ok: false,
    scanned: 10,
    changed: 2,
    missingInVault: 3,
    contentConflicts: 1,
    missingNoteIdCount: 3,
    errorCode: "upstream_error"
  });
  assert.ok(!JSON.stringify(summary).includes("note-a"), "note IDs must not be logged");
});
