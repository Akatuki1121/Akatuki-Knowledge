import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const policyStart = source.indexOf("const ARCHIVED_REBIND_TARGETS");
const policyEnd = source.indexOf("function getArchivedRebindTarget", policyStart);
assert.ok(policyStart >= 0 && policyEnd > policyStart, "inline archived-rebind policy must exist in the recovered Worker bundle");
const policySource = source.slice(policyStart, source.indexOf("\n}", policyEnd) + 2);
const { ARCHIVED_REBIND_TARGETS, validateArchivedRebind } = new Function(policySource + "\nreturn { ARCHIVED_REBIND_TARGETS, validateArchivedRebind };")();

const expectedD1Hash = "a".repeat(64);
const expectedVaultHash = "b".repeat(64);
function validInput(target) {
  return {
    path: target.path,
    expectedOldFileId: target.oldFileId,
    expectedCurrentFileId: target.currentFileId,
    expectedSyncUuid: target.syncUuid,
    expectedD1Hash,
    expectedVaultHash,
    actualD1Hash: expectedD1Hash,
    actualVaultHash: expectedVaultHash,
    observationComplete: true,
    note: { id: target.path, path: target.path, deleted_at: "2026-10-20T00:00:00.000Z", content_hash: expectedD1Hash },
    mappings: [{ file_id: target.oldFileId, sync_uuid: target.syncUuid, note_id: target.path, last_path: target.path }],
    observation: { path: target.path, fileId: target.currentFileId, contentHash: expectedVaultHash, deleted: false },
    vault: { path: target.path, fileId: target.currentFileId, contentHash: expectedVaultHash }
  };
}

assert.equal(ARCHIVED_REBIND_TARGETS.length, 11, "the allowlist contains seven existing Inbox targets plus four exact additional targets");
assert.equal(validateArchivedRebind({ path: "Notes/履歴/履歴 (YAOS conflict - disk from device-mv9dhgcw 2026-10-16T04-53-31Z).md" }).error, "path_not_allowed", "the history target with a D1/vault path mismatch is excluded");
assert.equal(validateArchivedRebind({ path: "Notes/Inbox/Purge conflict.md" }).error, "path_not_allowed", "deleted Purge conflict notes are excluded");
for (const target of ARCHIVED_REBIND_TARGETS) {
  const result = validateArchivedRebind(validInput(target));
  assert.equal(result.ok, true, "exact allowlisted target should pass: " + target.path);
  assert.equal(result.target.path, target.path);
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[0]);
  input.actualD1Hash = "c".repeat(64);
  assert.equal(validateArchivedRebind(input).error, "content_hash_precondition_failed", "D1 hash mismatch is rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[1]);
  input.vault.contentHash = "c".repeat(64);
  assert.equal(validateArchivedRebind(input).error, "content_hash_precondition_failed", "vault hash mismatch is rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[2]);
  input.note.deleted_at = null;
  assert.equal(validateArchivedRebind(input).error, "archived_note_precondition_failed", "live D1 rows are rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[3]);
  input.mappings.push({ file_id: input.expectedCurrentFileId, sync_uuid: input.expectedSyncUuid, note_id: input.path, last_path: input.path });
  assert.equal(validateArchivedRebind(input).error, "identity_mapping_precondition_failed", "a mapping already attached to the current fileId is rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[4]);
  input.expectedCurrentFileId = "unexpected-file-id";
  assert.equal(validateArchivedRebind(input).error, "identity_precondition_failed", "an unexpected current fileId is rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[5]);
  input.path = "Notes/Inbox/not-on-the-list.md";
  assert.equal(validateArchivedRebind(input).error, "path_not_allowed", "unlisted paths are rejected");
}
{
  const input = validInput(ARCHIVED_REBIND_TARGETS[6]);
  input.path = "Notes/Inbox/another-note.md";
  assert.equal(validateArchivedRebind(input).error, "path_not_allowed", "directory membership does not expand the allowlist");
}

const readNoteStart = source.indexOf('if (action === "read-note") {');
const readNoteEnd = source.indexOf('if (action === "reconcile-note") {', readNoteStart);
assert.ok(readNoteStart >= 0 && readNoteEnd > readNoteStart, "actual Durable Object read-note handler must exist");
const readNoteHandler = source.slice(readNoteStart, readNoteEnd);
const readNotePaths = [...readNoteHandler.matchAll(/^\s*"([^"]+)",?$/gm)].map(match => match[1]);
for (const target of ARCHIVED_REBIND_TARGETS) {
  assert.ok(readNotePaths.includes(target.path), "read-note allowlist and repair allowlist must stay aligned: " + target.path);
}
for (const target of ARCHIVED_REBIND_TARGETS) {
  assert.ok(readNoteHandler.includes(JSON.stringify(target.path)), "Durable Object read-note allowlist must include repair target: " + target.path);
}
const repairRouteStart = source.indexOf('if (url.pathname === "/sync/restore-archived-rebind" && request.method === "POST") {');
const repairRouteAuth = source.indexOf("if (!await isAuthorized(request, env))", repairRouteStart);
const repairRouteBody = source.indexOf("let body;", repairRouteStart);
assert.ok(repairRouteStart >= 0 && repairRouteAuth > repairRouteStart && repairRouteAuth < repairRouteBody, "repair endpoint authenticates before reading or applying the request");
assert.ok(source.includes('url.pathname === "/sync/restore-archived-rebind"'), "dedicated authenticated endpoint exists");
assert.ok(source.includes("INSERT INTO note_revisions (note_id, path, title, content, content_hash, saved_at) SELECT"), "old D1 content is recorded as a revision");
assert.ok(source.includes("deleted_at IS NOT NULL AND content_hash = ? AND sync_uuid = ?"), "restore is conditional on the archived D1 row and expected D1 hash");
assert.ok(source.includes("DELETE FROM yaos_file_identity_map WHERE file_id = ? AND sync_uuid = ? AND note_id = ? AND last_path = ?"), "the old identity mapping is removed only by exact identity");
assert.ok(source.includes("NOT EXISTS (SELECT 1 FROM yaos_file_identity_map WHERE file_id = ?)"), "the current fileId must be unmapped before rebind");
assert.ok(source.includes("restore_verification_failed"), "post-write state is verified");

for (const target of ARCHIVED_REBIND_TARGETS.slice(7)) {
  const input = validInput(target);
  assert.equal(validateArchivedRebind(input).ok, true, "new exact target is allowed: " + target.path);
  for (const key of ["expectedOldFileId", "expectedCurrentFileId", "expectedSyncUuid"]) {
    const rejected = validInput(target);
    rejected[key] = "mismatch";
    assert.equal(validateArchivedRebind(rejected).error, "identity_precondition_failed", "new target rejects mismatched " + key + ": " + target.path);
  }
  const live = validInput(target);
  live.note.deleted_at = null;
  assert.equal(validateArchivedRebind(live).error, "archived_note_precondition_failed", "new target rejects live D1 row: " + target.path);
  const d1Hash = validInput(target);
  d1Hash.actualD1Hash = "c".repeat(64);
  assert.equal(validateArchivedRebind(d1Hash).error, "content_hash_precondition_failed", "new target rejects D1 hash mismatch: " + target.path);
  const vaultHash = validInput(target);
  vaultHash.actualVaultHash = "c".repeat(64);
  assert.equal(validateArchivedRebind(vaultHash).error, "content_hash_precondition_failed", "new target rejects vault hash mismatch: " + target.path);
}

console.log("Guarded archived vault rebind tests passed: all 8 allowlisted targets; D1/vault hash mismatch; live D1 row; existing current-file mapping; unexpected fileId; unlisted path; exact revision, rebind, and verification contracts.");
