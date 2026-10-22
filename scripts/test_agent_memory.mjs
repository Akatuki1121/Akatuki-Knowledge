import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildAgentMemorySuppressionStatements,
  createAgentMemoryMetadata,
  isAgentMemorySuppressed,
  prepareAgentMemoryMetadataStatements,
  saveAgentMemoryMetadata
} from "../src/agent-memory.mjs";

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    return this.db.firstResult;
  }
}

class Database {
  constructor(firstResult = null) {
    this.firstResult = firstResult;
    this.prepared = [];
    this.batches = [];
  }

  prepare(sql) {
    const statement = new Statement(this, sql);
    this.prepared.push(statement);
    return statement;
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

const base = {
  source: "telegram",
  noteId: "tg:chat:message",
  memoryKind: "preference",
  memoryKey: "  ＡＩ  response style ",
  content: "Use concise Japanese replies.",
  confidence: 0.95,
  nowMs: Date.parse("2026-10-22T12:00:00.000Z")
};

const stated = await createAgentMemoryMetadata({ ...base, trustLevel: "user_stated" });
const normalized = await createAgentMemoryMetadata({
  ...base,
  memoryKey: "ai response style",
  content: "USE concise Japanese replies.",
  trustLevel: "user_stated"
});
assert.equal(stated.memoryKeyHash, normalized.memoryKeyHash);
assert.equal(stated.valueHash, normalized.valueHash);
assert.equal(stated.status, "active");
assert.equal(stated.trustLevel, "user_stated");
assert.equal("memoryKey" in stated, false);
assert.equal("content" in stated, false);

const inferred = await createAgentMemoryMetadata({ ...base, trustLevel: "inferred" });
assert.equal(inferred.status, "unverified");
const hypothesis = await createAgentMemoryMetadata({ ...base, memoryKind: "hypothesis", trustLevel: "user_stated" });
assert.equal(hypothesis.status, "unverified");

const temporary = await createAgentMemoryMetadata({
  ...base,
  memoryKind: "temporary_state",
  trustLevel: "user_stated"
});
assert.equal(Date.parse(temporary.expiresAt) - base.nowMs, 30 * 24 * 60 * 60 * 1000);
const boundedExpiry = await createAgentMemoryMetadata({
  ...base,
  memoryKind: "temporary_state",
  expiresAt: "2030-01-01T00:00:00.000Z",
  trustLevel: "user_stated"
});
assert.equal(Date.parse(boundedExpiry.expiresAt) - base.nowMs, 365 * 24 * 60 * 60 * 1000);
const confirmed = await createAgentMemoryMetadata({ ...base, trustLevel: "user_confirmed" });
assert.equal(confirmed.trustLevel, "user_confirmed");
assert.equal(confirmed.confirmedAt, confirmed.recordedAt);

await assert.rejects(
  createAgentMemoryMetadata({ ...base, confidence: 1.1 }),
  { name: "TypeError" }
);
await assert.rejects(
  createAgentMemoryMetadata({ ...base, contentHash: "not-a-hash" }),
  { name: "TypeError" }
);

const unconflictedDb = new Database();
const saved = await saveAgentMemoryMetadata(unconflictedDb, stated);
assert.equal(saved.status, "active");
assert.equal(unconflictedDb.batches[0].length, 1);
assert.match(unconflictedDb.batches[0][0].sql, /ON CONFLICT\(source, note_id, memory_key_hash, value_hash\)/u);

const conflictingDb = new Database({ existing: true });
const conflict = await saveAgentMemoryMetadata(conflictingDb, { ...stated, valueHash: "a".repeat(64) });
assert.equal(conflict.status, "conflicted");
assert.equal(conflictingDb.batches[0].length, 2);
assert.match(conflictingDb.batches[0][1].sql, /SET status = 'conflicted'/u);

const resolvingDb = new Database({ existing: true });
const resolving = await prepareAgentMemoryMetadataStatements(resolvingDb, {
  ...confirmed,
  valueHash: "b".repeat(64)
});
assert.equal(resolving.metadata.status, "active");
assert.match(resolving.statements[0].sql, /SET status = 'superseded'/u);
assert.equal(resolving.statements.length, 2);

const suppressionDb = new Database({ suppression_id: 1 });
assert.equal(await isAgentMemorySuppressed(suppressionDb, stated), true);
assert.deepEqual(suppressionDb.prepared[0].params, [
  stated.contentHash,
  stated.memoryKeyHash,
  stated.valueHash
]);
const suppressionStatements = buildAgentMemorySuppressionStatements(suppressionDb, {
  source: "telegram",
  noteId: stated.noteId,
  contentHash: stated.contentHash,
  createdAt: stated.updatedAt
});
assert.equal(suppressionStatements.length, 2);
assert.match(suppressionStatements[0].sql, /UNION ALL/u);
assert.match(suppressionStatements[0].sql, /FROM agent_memory_metadata/u);
assert.match(suppressionStatements[1].sql, /SET status = 'forgotten'/u);

const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.match(workerSource, /createAgentMemoryMetadata/u);
assert.match(workerSource, /NOT EXISTS\s*\(\s*SELECT 1 FROM agent_memory_suppressions/u);
assert.match(workerSource, /memory_status/u);
assert.match(workerSource, /status = 'superseded'/u);
assert.match(workerSource, /user_confirmed/u);

console.log("Agent memory metadata, trust, expiry, conflict, and suppression checks passed.");
