import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const route = 'if (url.pathname === "/sync/repair-identity-map" && request.method === "POST")';
assert.ok(source.includes(route), "repair endpoint must be routed inside the authenticated /sync boundary");
const start = source.indexOf(route);
const end = source.indexOf('if (url.pathname === "/sync/identity-review"', start);
assert.ok(start >= 0 && end > start, "guarded identity repair handler must exist");
const handler = source.slice(start, end);
for (const contract of [
  "noteId !== expectedPath",
  "note.content_hash !== expectedContentHash",
  "note.sync_uuid !== expectedSyncUuid",
  "await sha256(note.content) !== expectedContentHash",
  "identity_mapping_precondition_failed",
  "vault_observation_incomplete",
  "vault_identity_still_present",
  "DELETE FROM yaos_file_identity_map WHERE file_id = ? AND sync_uuid = ? AND note_id = ? AND last_path = ?",
  "WHERE changes() = 1",
  "expectedPreviousContent: previous?.content ?? null",
  "INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json"
]) assert.ok(handler.includes(contract), "Missing guarded identity-repair contract: " + contract);
assert.doesNotMatch(handler, /UPDATE notes\s+SET|SET content\s*=/, "repair must never modify note content");
assert.ok(source.includes('if (!await isAuthorized(request, env)) return Response.json({ error: "unauthorized"'), "repair must be behind sync authorization");
console.log("Guarded sync identity repair contract checks passed.");
