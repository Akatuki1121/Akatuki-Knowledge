import assert from "node:assert/strict";
import { createSyncOutbox, listSyncOutboxJobs, retrySyncOutboxJob } from "../src/sync-outbox.mjs";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const uuidB = "123e4567-e89b-42d3-a456-426614174001";
const outbox = createSyncOutbox({
  readUuid(content) {
    return content.match(/^---\r?\n[\s\S]*?^id:\s*["']?([0-9a-f-]+)["']?\s*$/im)?.[1] ?? null;
  },
  isValidSyncUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  },
  async deterministicUuid(seed) {
    assert.ok(seed);
    return uuid;
  }
});

{
  const inserted = [];
  const row = {
    id: "note-1", path: "notes/example.md", title: "Example",
    content: `---\nid: "${uuid}"\n---\ncontent`, content_hash: "hash",
    deleted_at: "2026-10-20T10:00:00.000Z", sync_uuid: uuid
  };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.includes("FROM notes WHERE id = ?")) return row;
          if (sql.includes("FROM note_revisions")) return { content: "previous content" };
          throw new Error("Unexpected first query: " + sql);
        },
        async run() {
          if (sql.startsWith("INSERT INTO yaos_sync_jobs")) inserted.push({ sql, values });
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  await outbox.enqueueSyncJob({ DB: db }, "notes", "note-1", "upsert", { allowRestore: true });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].values[1], "notes");
  assert.equal(inserted[0].values[2], "note-1");
  assert.equal(inserted[0].values[3], "delete", "An archived note must enqueue a tombstone, not an upsert");
  const payload = JSON.parse(inserted[0].values[4]);
  assert.equal(payload.syncUuid, uuid, "the D1 sync_uuid is retained for a delete/tombstone event");
  assert.equal(payload.expectedPreviousContent, "previous content");
  assert.equal(payload.allowRestore, true);
}

{
  const result = await outbox.backfillSyncUuidIndex({});
  assert.deepEqual(result, { ok: false, skipped: "missing_binding" });
}


{
  const inserted = [];
  const row = {
    id: "note-restore", path: "notes/restore.md", title: "Restore",
    content: "# Restored without an embedded identifier", content_hash: "hash",
    deleted_at: null, sync_uuid: uuid
  };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.includes("FROM notes WHERE id = ?")) return row;
          if (sql.includes("FROM note_revisions")) return { content: "# archived revision" };
          throw new Error("Unexpected first query: " + sql);
        },
        async run() {
          if (sql.startsWith("INSERT INTO yaos_sync_jobs")) inserted.push({ sql, values });
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  await outbox.enqueueSyncJob({ DB: db }, "notes", "note-restore", "upsert", { allowRestore: true });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].values[3], "upsert", "restoration is queued as an upsert after the tombstone");
  const payload = JSON.parse(inserted[0].values[4]);
  assert.equal(payload.syncUuid, uuid, "D1 sync_uuid remains authoritative without a frontmatter ID");
  assert.equal(payload.allowRestore, true);
}

{
  const inserted = [];
  const row = {
    id: "note-conflict", path: "notes/conflict.md", title: "Conflict",
    content: `---\\nid: "${uuidB}"\\n---\\n# legacy id conflicts with D1`, content_hash: "hash",
    deleted_at: null, sync_uuid: uuid
  };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { if (sql.includes("FROM notes WHERE id = ?")) return row; throw new Error("Unexpected first query: " + sql); },
        async all() { return { results: [] }; },
        async run() { if (sql.startsWith("INSERT INTO yaos_sync_jobs")) inserted.push({ sql, values }); return { meta: { changes: 1 } }; }
      };
    }
  };
  await assert.rejects(() => outbox.enqueueSyncJob({ DB: db }, "notes", "note-conflict", "upsert"), /sync_outbox_enqueue_failed/);
  assert.equal(inserted.length, 0, "a frontmatter/D1 UUID conflict must not enqueue an overwrite");
}

console.log("Sync outbox module tests passed.");

{
  const listed = [];
  let retrySql = "";
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() {
          assert.match(sql, /SELECT job_id, entity_type, entity_id, operation, status, attempts/);
          assert.doesNotMatch(sql, /payload_json/, "Admin listing must never expose note payloads");
          listed.push({ sql, values });
          return { results: [{ job_id: 9, entity_type: "notes", entity_id: "n-1", operation: "upsert", status: "dead", attempts: 8, last_error: "vault_content_conflict" }] };
        },
        async run() {
          retrySql = sql;
          return { meta: { changes: 1 } };
        },
        async first() { return { status: "pending" }; }
      };
    }
  };
  const listing = await listSyncOutboxJobs({ DB: db }, { status: "dead", limit: 5 });
  assert.equal(listing.ok, true);
  assert.equal(listing.jobs[0].last_error, "vault_content_conflict");
  assert.deepEqual(listed[0].values, ["dead", 6]);
  assert.equal((await listSyncOutboxJobs({ DB: db }, { status: "secret" })).error, "invalid_status");
  assert.equal((await retrySyncOutboxJob({ DB: db }, 9)).requeued, true);
  assert.match(retrySql, /WHERE job_id = \? AND status = 'dead'/, "Only dead jobs may be retried");
  assert.doesNotMatch(retrySql, /attempts\s*=|last_error\s*=/, "Retry preserves attempt count and error evidence");
  assert.equal((await retrySyncOutboxJob({ DB: db }, 0)).error, "invalid_job_id");
}
