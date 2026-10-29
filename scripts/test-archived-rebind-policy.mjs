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

assert.equal(ARCHIVED_REBIND_TARGETS.length, 8, "the repair scope contains exactly eight paths");
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

assert.ok(source.includes('url.pathname === "/sync/restore-archived-rebind"'), "dedicated authenticated endpoint exists");
assert.ok(source.includes("INSERT INTO note_revisions (note_id, path, title, content, content_hash, saved_at) SELECT"), "old D1 content is recorded as a revision");
assert.ok(source.includes("deleted_at IS NOT NULL AND content_hash = ? AND sync_uuid = ?"), "restore is conditional on the archived D1 row and expected D1 hash");
assert.ok(source.includes("DELETE FROM yaos_file_identity_map WHERE file_id = ? AND sync_uuid = ? AND note_id = ? AND last_path = ?"), "the old identity mapping is removed only by exact identity");
assert.ok(source.includes("NOT EXISTS (SELECT 1 FROM yaos_file_identity_map WHERE file_id = ?)"), "the current fileId must be unmapped before rebind");
assert.ok(source.includes("restore_verification_failed"), "post-write state is verified");
console.log("Guarded archived vault rebind tests passed: all 8 allowlisted targets; D1/vault hash mismatch; live D1 row; existing current-file mapping; unexpected fileId; unlisted path; exact revision, rebind, and verification contracts.");
