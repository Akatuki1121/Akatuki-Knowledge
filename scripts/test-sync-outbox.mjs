import assert from "node:assert/strict";
import { createSyncOutbox } from "../src/sync-outbox.mjs";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
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
  assert.equal(payload.expectedPreviousContent, "previous content");
  assert.equal(payload.allowRestore, true);
}

{
  const result = await outbox.backfillSyncUuidIndex({});
  assert.deepEqual(result, { ok: false, skipped: "missing_binding" });
}

console.log("Sync outbox module tests passed.");
