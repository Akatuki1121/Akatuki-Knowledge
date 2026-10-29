import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const route = 'if (url.pathname === "/sync/vault-note" && request.method === "GET")';
const reconcileRoute = 'if (url.pathname === "/sync/reconcile-note" && request.method === "POST")';
assert.ok(source.includes(route), "vault body read route must exist");
assert.ok(source.includes(reconcileRoute), "guarded reconcile route must exist");
const allowed = [
  "Notes/Inbox/Meta社のMuseとは何か.md",
  "Notes/Inbox/Akatuki-Knowledge縮小完了の記録.md",
  "Notes/アル丸スマッシュ/参考/閉じていいIssueの検討.md",
  "Notes/電子工作/知識/M5Stamp-C3 Mate GPIO 注意点・検証メモ.md"
];
for (const path of allowed) assert.ok(source.includes(path), "Missing explicit allowlisted note path: " + path);
assert.doesNotMatch(source, /credentials.*\.md/, "credential note paths must not be included in this feature");
const start = source.indexOf("  async reconcileSpecificNote(body) {");
const end = source.indexOf("  async applyKnowledgeSyncJob(job) {", start);
assert.ok(start >= 0 && end > start, "guarded reconciliation implementation must exist");
const reconcile = source.slice(start, end);
for (const contract of [
  "expectedD1Hash",
  "expectedVaultHash",
  "vault_hash_precondition_failed",
  "d1_hash_precondition_failed",
  "d1_compare_and_swap_failed",
  "directionByPath",
  "direction_mismatch",
  "verified: true",
  "await sha256Hex(note.content) !== expectedD1Hash",
  'direction === "vault_to_d1"',
  "textValue.delete(0, textValue.length)",
  "pathToId.set(path, current.fileId)",
  "post_reconcile_verification_failed",
  "UPDATE notes SET content = ?, content_hash = ?",
  "INSERT INTO note_revisions",
  "path_not_allowed"
]) assert.ok(reconcile.includes(contract), "Missing guarded reconciliation contract: " + contract);

// Every reconcile target keeps its direction fixed per note; the original
// four entries must stay exactly as they were.
const directionByPath = new Map([
  ["Notes/Inbox/Meta社のMuseとは何か.md", "d1_to_vault"],
  ["Notes/Inbox/Akatuki-Knowledge縮小完了の記録.md", "vault_to_d1"],
  ["Notes/アル丸スマッシュ/参考/閉じていいIssueの検討.md", "d1_to_vault"],
  ["Notes/電子工作/知識/M5Stamp-C3 Mate GPIO 注意点・検証メモ.md", "d1_to_vault"],
  ["Notes/思想/知識/哲学的剃刀10選.md", "vault_to_d1"],
  ["Notes/思想/知識/デジタル・ミニマリズム.md", "vault_to_d1"],
  ["Notes/思想/思考/ローカルメモへの回帰理由.md", "vault_to_d1"],
  ["Notes/思想/思考/2026-06-14_選択疲労と意思決定の本質.md", "vault_to_d1"],
  ["Notes/AI論/思考/AI とエコーチャンバー.md", "vault_to_d1"]
]);
for (const [path, direction] of directionByPath) {
  assert.ok(reconcile.includes(JSON.stringify(path)), "Missing reconcile target in Durable Object allowlist: " + path);
  assert.ok(
    reconcile.includes(`[${JSON.stringify(path)}, ${JSON.stringify(direction)}]`),
    "Missing or changed fixed direction for reconcile target: " + path
  );
}

// The five live-conflict notes additionally freeze the audited D1
// updated_at as a precondition, so a later D1 write refuses the intake.
for (const contract of [
  "frozenD1UpdatedAtPaths",
  '"2026-10-25T16:07:55.999Z"',
  "d1_updated_at_precondition_failed",
  "note.updated_at !== frozenD1UpdatedAt"
]) assert.ok(reconcile.includes(contract), "Missing frozen D1 updated_at precondition contract: " + contract);
for (const path of [
  "Notes/思想/知識/哲学的剃刀10選.md",
  "Notes/思想/知識/デジタル・ミニマリズム.md",
  "Notes/思想/思考/ローカルメモへの回帰理由.md",
  "Notes/思想/思考/2026-06-14_選択疲労と意思決定の本質.md",
  "Notes/AI論/思考/AI とエコーチャンバー.md"
]) assert.ok(reconcile.includes(path), "Missing frozen updated_at target: " + path);

// The YAOS conflict copy is inspection-only: it is readable through the
// route-level read-only set and the Durable Object read-note allowlist,
// but it must never become a reconcile target.
const conflictCopy = "Notes/AI論/思考/AI とエコーチャンバー (YAOS conflict - disk from device-mv9dhgcw 2026-10-25T16-12-41Z).md";
assert.ok(source.includes(conflictCopy), "Missing inspection-only conflict copy path: " + conflictCopy);
assert.ok(!reconcile.includes(conflictCopy), "conflict copy must not be a reconcile target");
assert.ok(source.includes("vaultNoteReadOnlyPaths"), "route must keep a separate read-only path set");
const readNoteStart = source.indexOf('if (action === "read-note") {');
const readNoteEnd = source.indexOf('if (action === "reconcile-note") {', readNoteStart);
assert.ok(readNoteStart >= 0 && readNoteEnd > readNoteStart, "Durable Object read-note handler must exist");
const readNote = source.slice(readNoteStart, readNoteEnd);
assert.ok(readNote.includes(conflictCopy), "read-note allowlist must include the inspection-only conflict copy");
for (const path of directionByPath.keys()) {
  assert.ok(readNote.includes(path), "read-note allowlist must include every reconcile target: " + path);
}
// A read-only target without a D1 counterpart returns the vault body alone.
assert.ok(source.includes("d1: null"), "vault-note inspection must tolerate a missing D1 counterpart for read-only targets");

assert.ok(source.includes('await mutate(doc2)'), "vault mutation must await asynchronous hash and D1 precondition checks");
assert.ok(source.includes('d1: { content: d1.content, contentHash: d1.content_hash }, vault: { content: vault.content, contentHash: vault.contentHash, fileId: vault.fileId }'), "inspection must expose both current bodies and hashes");
assert.ok(source.includes('if (!await isAuthorized(request, env)) return Response.json({ error: "unauthorized"'), "sync routes must require authorization");
console.log("Guarded vault note reconciliation contract checks passed.");
