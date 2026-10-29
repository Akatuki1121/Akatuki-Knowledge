import assert from "node:assert/strict";
import { createSyncOutbox, listSyncOutboxJobs, retrySyncOutboxJob, purgeDeadSyncOutboxJobs } from "../src/sync-outbox.mjs";

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

// prepareSyncJob returns the write statements without executing them, so a
// caller can commit a note mutation and its outbox event in one batch.
function statementDb({ row = null, owners = [] } = {}) {
  const executed = [];
  const db = {
    prepare(sql) {
      let values = [];
      const statement = {
        sql,
        get values() { return values; },
        bind(...args) { values = args; return statement; },
        async first() {
          if (sql.includes("FROM notes WHERE id = ?")) return row;
          if (sql.includes("FROM note_revisions")) return { content: "db previous content" };
          throw new Error("Unexpected first query: " + sql);
        },
        async all() {
          if (sql.includes("FROM notes WHERE sync_uuid = ?")) return { results: owners };
          throw new Error("Unexpected all query: " + sql);
        },
        async run() { executed.push({ sql, values }); return { meta: { changes: 1 } }; }
      };
      return statement;
    }
  };
  return { db, executed };
}

{
  // Preparation alone must not write anything; the caller decides when the
  // statements run (inside its own batch).
  const row = {
    id: "note-prep", path: "notes/prep.md", title: "Prep",
    content: `---\nid: "${uuid}"\n---\ncontent`, content_hash: "hash",
    deleted_at: null, sync_uuid: uuid
  };
  const { db, executed } = statementDb({ row });
  const prepared = await outbox.prepareSyncJob({ DB: db }, "notes", "note-prep", "upsert");
  assert.equal(executed.length, 0, "prepareSyncJob must not execute write statements");
  assert.equal(prepared.statements.length, 1, "a settled identity needs only the job insert");
  assert.ok(prepared.statements[0].sql.startsWith("INSERT INTO yaos_sync_jobs"));
  assert.equal(prepared.effectiveOperation, "upsert");
  const payload = JSON.parse(prepared.statements[0].values[4]);
  assert.equal(payload.syncUuid, uuid);
  assert.equal(payload.expectedPreviousContent, "db previous content", "without a snapshot the latest revision is read from D1");
  for (const statement of prepared.statements) await statement.run();
  assert.equal(executed.length, 1);
}

{
  // Snapshot path (the correction shape): the D1 row does not yet hold the
  // new content, so the row read must be skipped and the payload must
  // describe the snapshot. A missing sync_uuid is backfilled from the
  // content UUID as a prepared statement, ahead of the job insert.
  const snapshotRow = {
    id: "note-snap", path: "notes/snap.md", title: "Snap",
    content: `---\nid: "${uuid}"\n---\nnew content`, content_hash: "newhash",
    deleted_at: null, sync_uuid: null
  };
  const { db, executed } = statementDb({ row: null, owners: [] });
  const prepared = await outbox.prepareSyncJob({ DB: db }, "notes", "note-snap", "upsert", {}, {
    row: snapshotRow,
    previousRevisionContent: "content before correction"
  });
  assert.equal(executed.length, 0);
  assert.equal(prepared.statements.length, 2, "sync_uuid backfill precedes the job insert");
  assert.ok(prepared.statements[0].sql.startsWith("UPDATE notes SET sync_uuid = ?"));
  assert.deepEqual(prepared.statements[0].values.slice(0, 2), [uuid, "note-snap"]);
  const payload = JSON.parse(prepared.statements[1].values[4]);
  assert.equal(payload.content, snapshotRow.content, "the event describes the post-mutation content");
  assert.equal(payload.contentHash, "newhash");
  assert.equal(payload.expectedPreviousContent, "content before correction", "the snapshot supplies the pre-correction revision");
  assert.equal(payload.syncUuid, uuid);
}

{
  // A snapshot whose content UUID contradicts the D1 sync_uuid fails during
  // preparation, before the caller has committed anything.
  const snapshotRow = {
    id: "note-snap-conflict", path: "notes/snap-conflict.md", title: "Snap conflict",
    content: `---\nid: "${uuidB}"\n---\nconflicting`, content_hash: "hash",
    deleted_at: null, sync_uuid: uuid
  };
  const { db, executed } = statementDb({ row: null });
  await assert.rejects(
    () => outbox.prepareSyncJob({ DB: db }, "notes", "note-snap-conflict", "upsert", {}, { row: snapshotRow, previousRevisionContent: null }),
    /sync_outbox_enqueue_failed/
  );
  assert.equal(executed.length, 0, "a conflicting snapshot must fail before any write");
}

{
  // Guarded insert (the delete/restore shape): the job insert becomes an
  // INSERT ... SELECT gated on the post-mutation row state.
  const row = {
    id: "note-guard", path: "notes/guard.md", title: "Guard",
    content: "# guard", content_hash: "hash",
    deleted_at: "2026-10-29T00:00:00.000Z", sync_uuid: uuid
  };
  const { db } = statementDb({ row });
  const prepared = await outbox.prepareSyncJob({ DB: db }, "notes", "note-guard", "delete", { jobGuard: { checks: [["deleted_at", "2026-10-29T00:00:00.000Z"]] } });
  assert.equal(prepared.statements.length, 1);
  const insert = prepared.statements[0];
  assert.match(insert.sql, /INSERT INTO yaos_sync_jobs .* SELECT /, "guarded jobs use INSERT ... SELECT");
  assert.ok(insert.sql.includes("WHERE EXISTS (SELECT 1 FROM notes WHERE id = ? AND deleted_at = ?)"));
  assert.deepEqual(insert.values.slice(-2), ["note-guard", "2026-10-29T00:00:00.000Z"], "guard bindings follow the job values");
  assert.equal(prepared.effectiveOperation, "delete");

  const restored = await outbox.prepareSyncJob({ DB: db }, "notes", "note-guard", "upsert", { allowRestore: true, jobGuard: { checks: [["deleted_at", null], ["updated_at", "2026-10-29T01:00:00.000Z"]] } }, {
    row: { ...row, deleted_at: null },
    previousRevisionContent: null
  });
  const restoreInsert = restored.statements[0];
  assert.ok(restoreInsert.sql.includes("deleted_at IS NULL AND updated_at = ?"), "a null guard value becomes IS NULL");
  assert.deepEqual(restoreInsert.values.slice(-2), ["note-guard", "2026-10-29T01:00:00.000Z"]);

  await assert.rejects(
    () => outbox.prepareSyncJob({ DB: db }, "notes", "note-guard", "upsert", { jobGuard: { checks: [["content", "x"]] } }),
    /sync_outbox_enqueue_failed/,
    "guard columns outside the timestamp allowlist are rejected"
  );
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

{
  const rows = [
    { job_id: 1, status: "dead", last_error: "Error: vault_content_conflict: vault content differs from D1" },
    { job_id: 2, status: "dead", last_error: "sync_identity_mapping_conflict" },
    { job_id: 3, status: "pending", last_error: null },
    { job_id: 4, status: "processing", last_error: null },
    { job_id: 5, status: "sent", last_error: null }
  ];
  const deleted = [];
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() {
          assert.match(sql, /SELECT job_id, status, last_error FROM yaos_sync_jobs/);
          const selected = sql.includes("WHERE status = 'dead'") ? rows.filter(row => row.status === "dead") : rows.filter(row => values.includes(row.job_id));
          return { results: selected };
        },
        async run() {
          assert.match(sql, /DELETE FROM yaos_sync_jobs WHERE job_id = \? AND status = 'dead'/);
          const id = values[0];
          const index = rows.findIndex(row => row.job_id === id && row.status === "dead");
          if (index >= 0) { deleted.push(id); rows.splice(index, 1); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
      };
    }
  };
  const preview = await purgeDeadSyncOutboxJobs({ DB: db }, { dryRun: true });
  assert.deepEqual(preview.targetIds, [1, 2]);
  assert.deepEqual(preview.errorCounts, { vault_content_conflict: 1, sync_identity_mapping_conflict: 1 });
  assert.deepEqual(deleted, [], "dryRun must never delete rows");
  const targeted = await purgeDeadSyncOutboxJobs({ DB: db }, { jobIds: [1, 3, 4, 5, 99] });
  assert.deepEqual(targeted.deletedIds, [1]);
  assert.deepEqual(targeted.skipped, [
    { jobId: 3, reason: "job_not_dead", status: "pending" },
    { jobId: 4, reason: "job_not_dead", status: "processing" },
    { jobId: 5, reason: "job_not_dead", status: "sent" },
    { jobId: 99, reason: "job_not_found" }
  ]);
  const empty = await purgeDeadSyncOutboxJobs({ DB: db }, { jobIds: [1] });
  assert.deepEqual(empty.deletedIds, []);
  assert.equal(empty.deletedCount, 0, "purging an already-removed job is idempotent");
  assert.equal((await purgeDeadSyncOutboxJobs({ DB: db }, { jobIds: [0] })).error, "invalid_job_ids");
}
