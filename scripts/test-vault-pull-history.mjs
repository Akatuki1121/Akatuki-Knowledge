import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  buildVaultPullChangeRows,
  buildVaultPullRunRecord,
  getVaultPullRetentionCutoffs
} from "../src/vault-pull-history.mjs";

const migration = await readFile(new URL("../migrations/pending/0021_vault_pull_runs.sql", import.meta.url), "utf8");
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");

db.exec(migration);

const runColumns = db.prepare("PRAGMA table_info(vault_pull_runs)").all().map((column) => column.name);
assert.deepEqual(runColumns, [
  "id", "trigger", "started_at", "finished_at", "duration_ms", "ok", "stage", "error_code",
  "queued", "created", "updated", "vault_files", "reconcile_scanned", "reconcile_matched",
  "reconcile_missing_in_vault", "reconcile_content_conflicts", "reconcile_duplicate_paths", "reconcile_uuid_conflicts"
]);

const changeColumns = db.prepare("PRAGMA table_info(vault_pull_changes)").all().map((column) => column.name);
assert.deepEqual(changeColumns, ["run_id", "path", "source_modified_at", "applied_at"]);

const run = buildVaultPullRunRecord({
  id: 7,
  startedMs: 1_000,
  finishedMs: 2_250,
  finishedAt: "2026-11-25T00:00:02.250Z",
  result: { ok: true, queued: 3, created: 1, updated: 2, vaultFiles: 42 },
  error: null,
  errorCode: null
});
assert.deepEqual(run, {
  id: 7,
  finishedAt: "2026-11-25T00:00:02.250Z",
  durationMs: 1_250,
  ok: 1,
  stage: null,
  errorCode: null,
  queued: 3,
  created: 1,
  updated: 2,
  vaultFiles: 42
});

const failed = buildVaultPullRunRecord({
  id: 8,
  startedMs: 2_000,
  finishedMs: 2_500,
  finishedAt: "2026-11-25T00:00:02.500Z",
  result: { ok: false, stage: "read_vault", error: "status_502" },
  error: null,
  errorCode: "status_502"
});
assert.equal(failed.ok, 0);
assert.equal(failed.stage, "read_vault");
assert.equal(failed.errorCode, "status_502");

const changes = buildVaultPullChangeRows(7, [
  { path: "Notes/a.md", sourceModifiedAt: "2026-11-24T23:59:00.000Z", appliedAt: "2026-11-25T00:00:01.000Z" },
  { path: "Notes/b.md", sourceModifiedAt: null, appliedAt: "2026-11-25T00:00:02.000Z" },
  { path: "", appliedAt: "2026-11-25T00:00:02.000Z" },
  { path: "Notes/c.md" }
]);
assert.equal(changes.length, 2);
db.prepare("INSERT INTO vault_pull_runs (id, trigger, started_at, finished_at, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?)").run(
  run.id, "scheduled", "2026-11-25T00:00:01.000Z", run.finishedAt, run.durationMs, run.ok
);
const insertChange = db.prepare("INSERT INTO vault_pull_changes (run_id, path, source_modified_at, applied_at) VALUES (?, ?, ?, ?)");
for (const change of changes) insertChange.run(change.runId, change.path, change.sourceModifiedAt, change.appliedAt);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vault_pull_changes WHERE run_id = 7").get().count, 2);
assert.throws(() => db.prepare("INSERT INTO vault_pull_runs (trigger, started_at) VALUES (?, ?)").run("read", "2026-11-25T00:00:00.000Z"));

const now = Date.parse("2026-11-25T00:00:00.000Z");
const cutoffs = getVaultPullRetentionCutoffs(now);
assert.equal(cutoffs.runsBefore, "2026-10-26T00:00:00.000Z");
assert.equal(cutoffs.changesBefore, "2026-05-29T00:00:00.000Z");

assert.match(source, /beginVaultPullRun\(env, "scheduled"\)/);
assert.match(source, /beginVaultPullRun\(env, "post_write"\)/);
assert.match(source, /appliedChanges/);
assert.match(source, /cleanupVaultPullHistory/);

db.close();
console.log("Vault pull history contract passed.");
