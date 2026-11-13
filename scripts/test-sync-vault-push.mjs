import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSyncOutbox } from "../src/sync-outbox.mjs";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(request, env) {`);
  const marker = `__name(${name}, "${name}");`;
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, `Could not extract ${name} from the Worker bundle`);
  return source.slice(start, end);
}
const syncNotesSource = extractFunction("syncNotes");
const pushVaultNoteSource = extractFunction("pushVaultNote");

assert.match(source, /url\.pathname === "\/api\/sync\/push-note"/, "the push route is registered");
assert.ok(
  source.indexOf("/api/sync/push-note") > source.indexOf('url.pathname.startsWith("/api/")'),
  "the push route sits behind the /api authorization gate"
);

function readUuid(content) {
  const fm = String(content || "").slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm?.[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
}
function isValidSyncUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
const hash = (text) => createHash("sha256").update(text).digest("hex");

function makeDb(initialNotes = [], initialMappings = []) {
  const notes = structuredClone(initialNotes);
  const mappings = structuredClone(initialMappings);
  const reviews = [];
  const revisions = [];
  const jobs = [];
  const db = {
    notes, mappings, reviews, revisions, jobs,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.includes("FROM note_archive_events")) return { archive_event_id: 1, previous_ai_allowed: 1, previous_review_state: "ready" };
          if (sql.includes("FROM note_revisions") && sql.includes("content_hash = ?")) return revisions.some((r) => r.note_id === values[0] && r.content_hash === values[1]) ? { revision_id: 1 } : null;
          if (sql.includes("FROM note_revisions")) return revisions.length ? { content: revisions.at(-1).content } : null;
          if (sql.includes("FROM yaos_file_identity_map WHERE last_path = ? AND file_id <> ?")) return mappings.find((m) => m.last_path === values[0] && m.file_id !== values[1]) ?? null;
          if (sql.includes("FROM yaos_file_identity_map")) {
            const rows = await this.all();
            return rows.results[0] ?? null;
          }
          if (sql.includes("FROM notes WHERE path = ?") && sql.includes("id <> ?")) return notes.find((n) => n.path === values[0] && n.id !== values[1] && !n.deleted_at) ?? null;
          if (sql.includes("FROM notes WHERE path = ?")) return notes.find((n) => n.path === values[0]) ?? null;
          if (sql.includes("FROM notes WHERE id = ?")) return notes.find((n) => n.id === values[0]) ?? null;
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("entity_id = ?")) return jobs.find((j) => j.entity_id === values[0] && ["pending", "processing"].includes(j.status)) ?? null;
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("json_extract")) return jobs.find((j) => j.path === values[0] && ["pending", "processing"].includes(j.status)) ?? null;
          throw new Error("Unexpected first SQL: " + sql);
        },
        async all() {
          if (sql.includes("FROM yaos_sync_identity_review")) {
            const classification = sql.match(/classification = '([^']+)'/)?.[1];
            const reason = sql.match(/reason = '([^']+)'/)?.[1];
            const reasons = sql.includes("reason IN")
              ? [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1])
              : null;
            const fileId = sql.includes("file_id = ?") ? values[0] : undefined;
            return { results: reviews.filter((r) =>
              (classification === undefined || r.classification === classification) &&
              (reason === undefined || r.reason === reason) &&
              (!reasons || reasons.includes(r.reason)) &&
              (fileId === undefined || r.file_id === fileId)
            ).map((r) => ({ ...r })) };
          }
          if (sql.includes("FROM yaos_sync_jobs") && sql.includes("status = 'dead'")) return { results: jobs.filter((j) => j.entity_id === values[0] && j.status === "dead").map((j) => ({ ...j })) };
          if (sql.includes("FROM yaos_file_identity_map m INNER JOIN notes n")) {
            return { results: mappings.filter((m) => notes.some((n) => n.id === m.note_id && n.deleted_at)).map((m) => ({ ...m })) };
          }
          if (sql.includes("FROM yaos_file_identity_map") && sql.includes("WHERE last_path = ?")) {
            return { results: mappings.filter((m) => m.last_path === values[0]).map((m) => ({ ...m })) };
          }
          if (sql.includes("FROM yaos_file_identity_map")) {
            const [fileId, noteId, syncUuid] = values;
            return { results: mappings.filter((m) =>
              (fileId && m.file_id === fileId) || (noteId && m.note_id === noteId) || (syncUuid && m.sync_uuid === syncUuid)
            ).map((m) => ({ ...m })) };
          }
          if (sql.includes("FROM notes WHERE id = ? OR path = ?")) {
            return { results: notes.filter((n) => n.id === values[0] || n.path === values[1]).map((n) => ({ ...n })) };
          }
          if (sql.includes("FROM notes WHERE sync_uuid = ?")) return { results: notes.filter((n) => n.sync_uuid === values[0]).map((n) => ({ ...n })) };
          if (sql.includes("FROM notes")) return { results: notes.map((n) => ({ ...n })) };
          throw new Error("Unexpected all SQL: " + sql);
        },
        async run() {
          const v = values;
          if (sql.startsWith("INSERT INTO yaos_sync_identity_review")) {
            const row = { file_id: v[0], path: v[1], content_hash: v[2], classification: v[3], reason: v[4], first_seen_at: v[5], last_seen_at: v[6] };
            const existing = reviews.find((r) => r.file_id === row.file_id);
            if (existing) Object.assign(existing, row, { first_seen_at: existing.first_seen_at });
            else reviews.push(row);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE note_archive_events")) return { meta: { changes: 1 } };
          if (sql.startsWith("DELETE FROM agent_memory_suppressions")) return { meta: { changes: 1 } };
          if (sql.startsWith("DELETE FROM yaos_sync_identity_review")) {
            const reason = sql.match(/reason = '([^']+)'/)?.[1];
            const reasons = sql.includes("reason IN") ? [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
            const before = reviews.length;
            for (let i = reviews.length - 1; i >= 0; i--) {
              if (reviews[i].file_id === v[0] && (reasons ? reasons.includes(reviews[i].reason) : reason === undefined || reviews[i].reason === reason)) reviews.splice(i, 1);
            }
            return { meta: { changes: before - reviews.length } };
          }
          if (sql.startsWith("INSERT INTO yaos_file_identity_map")) {
            const row = { file_id: v[0], sync_uuid: v[1], note_id: v[2], last_path: v[3], created_at: v[4], updated_at: v[5] };
            const sameFile = mappings.find((m) => m.file_id === row.file_id);
            if (sameFile && sql.includes("ON CONFLICT(file_id) DO UPDATE")) {
              if (sameFile.note_id !== row.note_id || sameFile.sync_uuid !== row.sync_uuid) throw new Error("UNIQUE constraint failed");
              sameFile.last_path = row.last_path;
              sameFile.updated_at = row.updated_at;
              return { meta: { changes: 1 } };
            }
            if (mappings.some((m) => m.file_id === row.file_id || m.note_id === row.note_id || m.sync_uuid === row.sync_uuid)) throw new Error("UNIQUE constraint failed");
            mappings.push(row);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ? WHERE id = ? AND path = ? AND sync_uuid = ? AND content_hash = ?")) {
            const row = notes.find((n) => n.id === v[1] && n.path === v[2] && n.sync_uuid === v[3] && n.content_hash === v[4] && !n.deleted_at);
            const mapping = mappings.find((m) => m.file_id === v[5] && m.note_id === v[6] && m.sync_uuid === v[7] && m.last_path === v[8]);
            if (row && mapping) row.path = v[0];
            return { meta: { changes: row && mapping ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE yaos_file_identity_map")) {
            const row = mappings.find((m) => m.file_id === v[2] && m.note_id === v[3] && m.sync_uuid === v[4] && m.last_path === v[5]);
            if (row) { row.last_path = v[0]; row.updated_at = v[1]; }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("DELETE FROM yaos_file_identity_map WHERE file_id = ? AND note_id = ? AND sync_uuid = ?")) {
            const index = mappings.findIndex((m) => m.file_id === v[0] && m.note_id === v[1] && m.sync_uuid === v[2]);
            if (index >= 0) mappings.splice(index, 1);
            return { meta: { changes: index >= 0 ? 1 : 0 } };
          }
          if (sql.startsWith("DELETE FROM yaos_file_identity_map WHERE note_id = ? OR sync_uuid = ?")) {
            const before = mappings.length;
            for (let i = mappings.length - 1; i >= 0; i--) {
              if (mappings[i].note_id === v[0] || (v[1] && mappings[i].sync_uuid === v[1])) mappings.splice(i, 1);
            }
            return { meta: { changes: before - mappings.length } };
          }
          if (sql.startsWith("UPDATE notes SET sync_uuid = ?")) {
            const row = notes.find((n) => n.id === v[1]);
            if (row && (!row.sync_uuid || row.sync_uuid === v[2])) row.sync_uuid = v[0];
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, source_modified_at")) {
            const row = notes.find((n) => n.id === v[4]);
            if (row) Object.assign(row, { path: v[0], sync_uuid: v[1], source_modified_at: v[2], imported_at: v[3] });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO yaos_sync_jobs")) {
            jobs.push({ job_id: jobs.length + 1, entity_type: v[1], entity_id: v[2], operation: v[3], payload_json: v[4], status: "pending", last_error: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO note_revisions")) {
            revisions.push({ note_id: v[0], path: v[1], title: v[2], content: v[3], content_hash: v[4], saved_at: v[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET path = ?, sync_uuid = ?, title = ?, content = ?, content_hash = ?")) {
            const restoring = sql.includes("deleted_at IS NOT NULL");
            const row = notes.find((n) => n.id === (restoring ? v[11] : v[9]));
            if (row) Object.assign(row, {
              path: v[0], sync_uuid: v[1], title: v[2], content: v[3], content_hash: v[4],
              source_modified_at: v[5], imported_at: v[6], updated_at: v[7], tags_json: v[8],
              ...(restoring ? { ai_allowed: v[9], review_state: v[10] } : {}), deleted_at: null
            });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE agent_memory_metadata")) return { meta: { changes: 0 } };
          if (sql.startsWith("INSERT INTO notes")) {
            const row = { id: v[0], path: v[1], sync_uuid: v[2], title: v[3], content: v[4], content_hash: v[5], source_modified_at: v[6], imported_at: v[7], updated_at: v[8], tags_json: v[9], deleted_at: null };
            if (notes.some((n) => n.id === row.id || n.path === row.path)) throw new Error("UNIQUE constraint failed");
            notes.push(row);
            return { meta: { changes: 1 } };
          }
          throw new Error("Unexpected run SQL: " + sql);
        }
      };
      return statement;
    }
  };
  return db;
}

const deps = {
  readJson: (request) => request.json(),
  json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  stableId: (path) => path.normalize("NFC").replaceAll("\\", "/"),
  titleFrom: (path, supplied) => supplied || path.split("/").at(-1).replace(/\.md$/i, ""),
  sha256: async (text) => hash(text),
  extractTags: (_content, tags) => tags || [],
  readUuid,
  isValidSyncUuid,
  MAX_NOTES_PER_SYNC: 20,
  MAX_NOTE_CHARS: 500000,
  RESERVED_ROOT: "__system",
  prepareSyncJob: createSyncOutbox({ readUuid, isValidSyncUuid, deterministicUuid: async (id) => hash(id).slice(0, 8) + "-0000-4000-8000-000000000000" }).prepareSyncJob
};
const syncNotes = new Function(...Object.keys(deps), "return (" + syncNotesSource + ");")(...Object.values(deps));
const pushDeps = { ...deps, syncNotes };
const pushVaultNote = new Function(...Object.keys(pushDeps), "return (" + pushVaultNoteSource + ");")(...Object.values(pushDeps));

const uuidA = "123e4567-e89b-42d3-a456-426614174001";
const uuidB = "123e4567-e89b-42d3-a456-426614174002";
const now = "2026-11-14T00:00:00.000Z";
const note = (id, path, content, sync_uuid = uuidA, deleted_at = null) => ({
  id, path, title: path.split("/").at(-1).replace(/\.md$/i, ""), content, content_hash: hash(content),
  sync_uuid, source_modified_at: null, imported_at: now, updated_at: now, tags_json: "[]", deleted_at
});
const mapping = (file_id, sync_uuid, note_id, last_path) => ({ file_id, sync_uuid, note_id, last_path, created_at: now, updated_at: now });
const push = (path, content, contentHash = hash(content)) => new Request("https://test/api/sync/push-note", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path, content, contentHash, clientSentAt: now })
});
const original = "# Existing\n\nversion one";
const edited = "# Existing\n\nversion two";

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const res = await pushVaultNote(push("Notes/a.md", edited), { DB: db });
  const result = await res.json();
  assert.equal(res.status, 200);
  assert.equal(result.result, "applied", "editing a mapped note applies to the same D1 row");
  assert.equal(result.syncUuid, uuidA);
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].content, edited);
  assert.equal(db.notes[0].sync_uuid, uuidA, "identity is preserved");
  assert.equal(db.revisions.length, 1, "the replaced body is preserved as a revision");

  const again = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(again.result, "unchanged", "pushing the same content twice is a no-op");
  assert.equal(db.revisions.length, 1, "an unchanged push writes no new revision");
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const result = await (await pushVaultNote(push("Notes/new.md", "# New\n\nfresh"), { DB: db })).json();
  assert.equal(result.result, "deferred");
  assert.equal(result.reason, "mapping_missing");
  assert.equal(db.notes.length, 1, "an unmapped push never creates a D1 note");
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  db.jobs.push({ job_id: 1, entity_type: "notes", entity_id: "Notes/a.md", operation: "upsert", payload_json: "{}", status: "pending", last_error: null });
  const result = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(result.result, "deferred", "a pending outbox delivery defers the push");
  assert.equal(result.reason, "outbox_operation_pending");
  assert.equal(db.notes[0].content, original, "D1 is not overwritten while a delivery is in flight");
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  db.jobs.push({ job_id: 1, entity_type: "notes", entity_id: "Notes/a.md", operation: "upsert", payload_json: JSON.stringify({ contentHash: hash(original) }), status: "dead", last_error: "vault_content_conflict" });
  const result = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(result.result, "needs_review", "a dead delivery keeps the push out of D1");
  assert.equal(result.reason, "dead_delivery_conflict");
  assert.equal(db.notes[0].content, original);
}

{
  const db = makeDb(
    [note("Notes/a.md", "Notes/a.md", original), note("Notes/b.md", "Notes/b.md", "# B", uuidB)],
    [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md"), mapping("file-B", uuidB, "Notes/b.md", "Notes/a.md")]
  );
  const result = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(result.result, "needs_review", "two mappings for one path fail closed");
  assert.equal(result.reason, "sync_identity_mapping_conflict");
  assert.equal(db.notes[0].content, original);
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const res = await pushVaultNote(push("Notes/a.md", edited, hash("something else")), { DB: db });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "content_hash_mismatch");
  assert.equal(db.notes[0].content, original);
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original, uuidA, now)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const result = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(result.result, "needs_review", "an archived note is not revived by a push");
  assert.equal(result.reason, "archived_note_identity");
}

{
  const db = makeDb([note("Notes/a.md", "Notes/moved.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const result = await (await pushVaultNote(push("Notes/a.md", edited), { DB: db })).json();
  assert.equal(result.result, "needs_review", "a path disagreement is not treated as a rename");
  assert.equal(result.reason, "path_identity_conflict");
  assert.equal(db.notes[0].path, "Notes/moved.md");
}

{
  const db = makeDb([note("Notes/a.md", "Notes/a.md", original)], [mapping("file-A", uuidA, "Notes/a.md", "Notes/a.md")]);
  const res = await pushVaultNote(push("../outside.md", edited), { DB: db });
  assert.equal(res.status, 400, "unsafe paths are rejected");
  const res2 = await pushVaultNote(push("Notes/a.txt", edited), { DB: db });
  assert.equal(res2.status, 400, "non-markdown paths are rejected");
}

console.log("test-sync-vault-push: all assertions passed");
