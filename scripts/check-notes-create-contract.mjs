import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const route = 'if (request.method === "POST" && url.pathname === "/api/notes")';
assert.ok(source.includes(route), "POST /api/notes must be routed behind the API authorization boundary");
const start = source.indexOf("async function createNote(request, env) {");
const end = source.indexOf('__name(createNote, "createNote");', start);
assert.ok(start >= 0 && end > start, "createNote handler must exist");
const handler = source.slice(start, end);
for (const contract of [
  'SELECT id FROM notes WHERE path = ?',
  'return json({ error: "note_path_exists", path }, 409)',
  'crypto.randomUUID()',
  'inspectWholeContent(content, env)',
  'reviewState = credential ? "blocked_credentials" : "ready"',
  'INSERT INTO notes (id, path, sync_uuid, title, content, content_hash',
  'INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json',
  'await env.DB.batch([',
  'return json({ ok: true, id: path, path, title, syncUuid, contentHash, aiAllowed: Boolean(aiAllowed), reviewState, queued: true }, 201)'
]) {
  assert.ok(handler.includes(contract), "Missing note-creation contract: " + contract);
}
assert.doesNotMatch(handler, /deterministicUuid|file_id\s*=/, "Akatuki must not derive sync identity from a path or invent a YAOS file ID");
assert.ok(source.includes('if (response.ok) ctx.waitUntil(drainSyncOutbox(env, 3))'), "Successful creation must trigger outbox draining");
console.log("Notes-create contract checks passed.");
