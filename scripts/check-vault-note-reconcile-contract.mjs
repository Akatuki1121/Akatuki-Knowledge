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
  "await sha256Hex(note.content) !== expectedD1Hash",
  'direction === "vault_to_d1"',
  'direction === "d1_to_vault"',
  "post_reconcile_verification_failed",
  "UPDATE notes SET content = ?, content_hash = ?",
  "INSERT INTO note_revisions",
  "path_not_allowed"
]) assert.ok(reconcile.includes(contract), "Missing guarded reconciliation contract: " + contract);
assert.ok(source.includes('await mutate(doc2)'), "vault mutation must await asynchronous hash and D1 precondition checks");
assert.ok(source.includes('if (!await isAuthorized(request, env)) return Response.json({ error: "unauthorized"'), "sync routes must require authorization");
console.log("Guarded vault note reconciliation contract checks passed.");
