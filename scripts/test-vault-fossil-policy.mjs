import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const policyStart = source.indexOf("const VAULT_FOSSIL_TARGETS");
const policyEnd = source.indexOf("function getVaultFossilTarget", policyStart);
assert.ok(policyStart >= 0 && policyEnd > policyStart, "inline vault-fossil policy must exist in the recovered Worker bundle");
const policySource = source.slice(policyStart, source.indexOf("\n}", policyEnd) + 2);
const { VAULT_FOSSIL_TARGETS, validateVaultFossilRemoval, getVaultFossilTarget } = new Function(policySource + "\nreturn { VAULT_FOSSIL_TARGETS, validateVaultFossilRemoval, getVaultFossilTarget };")();

assert.equal(VAULT_FOSSIL_TARGETS.length, 2, "only the two explicitly frozen fossil targets are allowlisted");
const target = VAULT_FOSSIL_TARGETS[0];
assert.equal(target.vaultPath, "Notes/履歴/履歴 (YAOS conflict - disk from device-mv9dhgcw 2026-10-16T04-53-31Z).md");
assert.equal(target.noteId, target.vaultPath, "the D1 row id is the history path");
assert.equal(target.notePath, target.tombstonePath, "the D1 path column is the Inbox path (the mismatch this repair exists for)");
assert.equal(getVaultFossilTarget(target.vaultPath), target);
assert.equal(getVaultFossilTarget(target.tombstonePath), null, "the Inbox tombstone path itself is not a removal target");

function validInput() {
  return {
    path: target.vaultPath,
    fileId: target.fileId,
    expectedContentHash: target.expectedContentHash,
    observationComplete: true,
    observation: { path: target.vaultPath, fileId: target.fileId, contentHash: target.expectedContentHash, deleted: false },
    tombstoneObservation: { path: target.tombstonePath, fileId: target.tombstoneFileId, deleted: true },
    note: { id: target.noteId, path: target.notePath, deleted_at: "2026-10-28T17:48:55.000Z", content_hash: target.expectedContentHash },
    actualD1Hash: target.expectedContentHash
  };
}

assert.equal(validateVaultFossilRemoval(validInput()).ok, true, "the exact measured fossil state passes");
assert.equal(validateVaultFossilRemoval(validInput()).alreadyDeleted, false);

const conflictCopy = VAULT_FOSSIL_TARGETS[1];
assert.equal(conflictCopy.vaultPath, "Notes/AI論/思考/AI とエコーチャンバー (YAOS conflict - disk from device-mv9dhgcw 2026-10-25T16-12-41Z).md");
assert.equal(conflictCopy.fileId, "FWadoGzyKLOx0QZP");
assert.equal(conflictCopy.expectedContentHash, "dea439798a8075d0f23710fc9f4f827529111d91e7685596d92628d521617206");
assert.equal(conflictCopy.comparisonPath, "Notes/AI論/思考/AI とエコーチャンバー.md");
assert.equal(conflictCopy.removableFrontmatterId, "89fbc6d9-3a74-52ab-89c8-7d682e16b736");
const originalBody = "---\\ntitle: Example\\n---\\n本文\\n";
const duplicateBody = originalBody.replace("---\\ntitle:", '---\\nid: "89fbc6d9-3a74-52ab-89c8-7d682e16b736"\\ntitle:');
const conflictInput = {
  path: conflictCopy.vaultPath,
  fileId: conflictCopy.fileId,
  expectedContentHash: conflictCopy.expectedContentHash,
  observationComplete: true,
  observation: { path: conflictCopy.vaultPath, fileId: conflictCopy.fileId, contentHash: conflictCopy.expectedContentHash, deleted: false },
  vaultContent: duplicateBody,
  comparisonContent: originalBody
};
assert.equal(validateVaultFossilRemoval(conflictInput).ok, true, "copy is removable only when stripping its frozen frontmatter id yields the canonical body");
{
  const input = { ...conflictInput, vaultContent: duplicateBody + "extra" };
  assert.equal(validateVaultFossilRemoval(input).error, "vault_fossil_content_mismatch", "body changes fail closed");
}
{
  const input = { ...conflictInput, comparisonContent: originalBody + "changed" };
  assert.equal(validateVaultFossilRemoval(input).error, "vault_fossil_content_mismatch", "canonical note changes fail closed");
}
{
  const input = { ...conflictInput, observation: { ...conflictInput.observation, fileId: "other-file" } };
  assert.equal(validateVaultFossilRemoval(input).error, "vault_observation_precondition_failed", "wrong fileId fails closed");
}
assert.equal(validateVaultFossilRemoval({ path: "Notes/履歴/履歴 (YAOS conflict - disk from device-other 2026-10-25T00-00-00Z).md" }).error, "path_not_allowed", "other conflict files are excluded");
assert.equal(validateVaultFossilRemoval({ path: target.tombstonePath }).error, "path_not_allowed", "the tombstone path is excluded");
assert.equal(validateVaultFossilRemoval({ path: "Notes/AI論/思考/AI とエコーチャンバー.md" }).error, "path_not_allowed", "unrelated notes are excluded");
{
  const input = validInput();
  input.fileId = "unexpected-file-id";
  assert.equal(validateVaultFossilRemoval(input).error, "identity_precondition_failed", "fileId mismatch is rejected");
}
{
  const input = validInput();
  input.expectedContentHash = "a".repeat(64);
  assert.equal(validateVaultFossilRemoval(input).error, "identity_precondition_failed", "a caller-supplied hash that differs from the allowlisted hash is rejected");
}
{
  const input = validInput();
  input.observation.contentHash = "b".repeat(64);
  assert.equal(validateVaultFossilRemoval(input).error, "vault_observation_precondition_failed", "vault hash mismatch aborts the repair");
}
{
  const input = validInput();
  input.actualD1Hash = "b".repeat(64);
  assert.equal(validateVaultFossilRemoval(input).error, "content_hash_precondition_failed", "a D1 content hash mismatch aborts the repair");
}
{
  const input = validInput();
  input.note.content_hash = "b".repeat(64);
  assert.equal(validateVaultFossilRemoval(input).error, "content_hash_precondition_failed", "a stored D1 hash mismatch aborts the repair");
}
{
  const input = validInput();
  input.note.deleted_at = null;
  assert.equal(validateVaultFossilRemoval(input).error, "archived_note_precondition_failed", "a live D1 row is rejected: the content would no longer be preserved as an archive");
}
{
  const input = validInput();
  input.note.path = input.note.id;
  assert.equal(validateVaultFossilRemoval(input).error, "archived_note_precondition_failed", "a D1 row whose id/path mismatch has disappeared no longer matches this repair");
}
{
  const input = validInput();
  input.observationComplete = false;
  assert.equal(validateVaultFossilRemoval(input).error, "vault_observation_precondition_failed", "partial vault observation is rejected");
}
{
  const input = validInput();
  input.observation = null;
  assert.equal(validateVaultFossilRemoval(input).error, "vault_fossil_not_found", "a missing vault entry is reported instead of assumed removed");
}
{
  const input = validInput();
  input.observation.deleted = true;
  const result = validateVaultFossilRemoval(input);
  assert.equal(result.ok, true, "an already tombstoned entry still validates so residue cleanup stays idempotent");
  assert.equal(result.alreadyDeleted, true);
}
{
  const input = validInput();
  input.tombstoneObservation.deleted = false;
  assert.equal(validateVaultFossilRemoval(input).error, "vault_observation_precondition_failed", "a tombstone that is no longer deleted aborts the repair");
}
{
  const input = validInput();
  input.tombstoneObservation = null;
  assert.equal(validateVaultFossilRemoval(input).ok, true, "an absent tombstone observation is reported by the endpoint checks, not a hard failure");
}

console.log("Vault fossil removal policy checks passed.");
