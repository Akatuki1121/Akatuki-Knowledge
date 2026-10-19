#!/usr/bin/env node
/**
 * Isolated integration test for Akatuki Knowledge -> local YAOS Worker.
 *
 * Requires YAOS_REPO_PATH to point at a checked-out YAOS repository with
 * root/server npm dependencies installed. All D1, Durable Object and R2 state
 * is local and disposable. This script never uses a remote binding or deploys.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const YAOS_ROOT = process.env.YAOS_REPO_PATH ? resolve(process.env.YAOS_REPO_PATH) : "";
if (!YAOS_ROOT) throw new Error("Set YAOS_REPO_PATH to a checked-out YAOS repository.");
const YAOS_SERVER = join(YAOS_ROOT, "server");
const YAOS_WRANGLER = join(YAOS_SERVER, "wrangler.toml");
const KNOWLEDGE_CONFIG = join(ROOT, ".wrangler.integration.tmp.toml");
const YAOS_CONFIG = join(YAOS_SERVER, ".wrangler.integration.tmp.toml");
const HOST = "http://127.0.0.1:8787";
const TOKEN = randomUUID() + randomUUID();
const VAULT_ID = "knowledge-integration-" + randomUUID();
const UUID = randomUUID();
const TEST_PATH = "Integration/roundtrip.md";
const RENAMED_PATH = "Integration/Renamed-roundtrip.md";
const WRANGLER = ["--yes", "wrangler@4.69.0"];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: options.stdio || "inherit",
      env: { ...process.env, ...(options.env || {}) },
    });
    let output = "";
    if (child.stdout) child.stdout.on("data", chunk => { output += chunk.toString(); });
    if (child.stderr) child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("error", rejectPromise);
    child.once("exit", code => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code})\n${output.slice(-6000)}`));
    });
  });
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(HOST + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text}`);
  return payload;
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}; last result: ${String(last)}`);
}

async function triggerDrain() {
  const response = await fetch(HOST + "/cdn-cgi/local/scheduled?cron=0+*+*+*+*");
  const text = await response.text();
  if (!response.ok) throw new Error(`Local scheduled invocation failed: HTTP ${response.status}: ${text}`);
}

async function waitForSent(previousCount) {
  return await waitFor(async () => {
    const status = await request("/sync/status");
    if (status.outbox?.ok && status.outbox.sent > previousCount) return status.outbox.sent;
    if (status.outbox?.dead > 0) throw new Error("Outbox contains dead jobs: " + JSON.stringify(status.outbox));
    return false;
  }, `outbox sent count > ${previousCount}`);
}

async function currentSentCount() {
  const status = await request("/sync/status");
  assert.equal(status.outbox?.ok, true, "outbox migration is active in local D1");
  return status.outbox.sent;
}

async function currentDeadCount() {
  const status = await request("/sync/status");
  assert.equal(status.outbox?.ok, true, "outbox migration is active in local D1");
  return status.outbox.dead || 0;
}

async function mutateYaosNote(path, suffix, clientPath) {
  // Use YAOS's own installed Yjs provider and schema to make a genuine
  // remote-side edit, rather than faking the verification response.
  const client = `
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
const host = "http://127.0.0.1:8787";
const doc = new Y.Doc();
const pathToId = doc.getMap("pathToId");
const idToText = doc.getMap("idToText");
const provider = new YSyncProvider(host, ${JSON.stringify(VAULT_ID)}, doc, {
  prefix: `/vault/sync/${encodeURIComponent(${JSON.stringify(VAULT_ID)})}`,
  params: { token: ${JSON.stringify(TOKEN)}, schemaVersion: "3" },
  WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
  connect: true,
});
let finished = false;
function done(code) {
  if (finished) return;
  finished = true;
  provider.destroy();
  doc.destroy();
  process.exitCode = code;
}
const timeout = setTimeout(() => { console.error("YAOS edit client timed out"); done(1); }, 10000);
provider.on("sync", synced => {
  if (!synced || finished) return;
  const id = pathToId.get(${JSON.stringify(path)});
  const text = id && idToText.get(id);
  if (!text) {
    console.error("YAOS note not found at path " + ${JSON.stringify(path)});
    clearTimeout(timeout);
    done(1);
    return;
  }
  text.insert(text.length, ${JSON.stringify(suffix)});
  setTimeout(() => { clearTimeout(timeout); done(0); }, 500);
});
`;
  await writeFile(clientPath, client);
  await run(process.execPath, [clientPath], { cwd: YAOS_SERVER });
}

async function importNote(path, content, title) {
  // /api/sync is the inbound YAOS -> D1 path and intentionally does not enqueue
  // outbound work. Use it only to seed the local D1 row, then exercise the
  // real correction/archive/restore mutation routes that enqueue outbox jobs.
  const result = await request("/api/sync", {
    method: "POST",
    body: { notes: [{ path, content, title }] },
  });
  assert.equal(result.ok, true, "sync endpoint accepts note");
  return result;
}

async function correctNote(id, content, title) {
  const result = await request("/api/notes/" + encodeURIComponent(id) + "/correction", {
    method: "POST",
    body: { content, title },
  });
  assert.equal(result.ok, true, "correction endpoint accepts note mutation");
  return result;
}

async function getNotes() {
  const result = await request("/api/notes?limit=100");
  assert.ok(Array.isArray(result.notes), "notes endpoint returns list");
  return result.notes;
}

function noteContent(text) {
  return `---\nid: ${UUID}\n---\n# Integration roundtrip\n\n${text}\n`;
}

async function main() {
  const stateDir = await mkdtemp(join(tmpdir(), "knowledge-yaos-e2e-"));
  let worker;
  let workerOutput = "";
  const clientPath = join(YAOS_SERVER, `.knowledge-integration-client-${UUID}.mjs`);
  const originalKnowledge = await readFile(join(ROOT, "wrangler.toml"), "utf8");
  const originalYaos = await readFile(YAOS_WRANGLER, "utf8");

  const knowledgeConfig = `name = "akatuki-knowledge-integration"
main = "src/index.js"
compatibility_date = "2026-10-17"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "knowledge-integration"
database_id = "00000000-0000-0000-0000-000000000001"

[[durable_objects.bindings]]
name = "YJS_CLIENT"
class_name = "YjsClientDO"

[[services]]
binding = "YAOS"
service = "yaos"

[vars]
API_TOKEN = "${TOKEN}"
VAULT_ID = "${VAULT_ID}"
YAOS_TOKEN = "${TOKEN}"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["YjsClientDO"]

[[migrations]]
tag = "v2"
deleted_classes = ["YjsClientDO"]

[[migrations]]
tag = "v3"
new_sqlite_classes = ["YjsClientDO"]

[[migrations]]
tag = "v4"
deleted_classes = ["YjsClientDO"]

[[migrations]]
tag = "v5"
new_sqlite_classes = ["YjsClientDO"]
`;

  const yaosConfig = originalYaos.replace(
    /\[observability\.logs\][\s\S]*$/,
    `[observability.logs]
enabled = false

[vars]
SYNC_TOKEN = "${TOKEN}"
`,
  );
  if (yaosConfig === originalYaos) throw new Error("Could not prepare isolated YAOS config.");
  if (!originalKnowledge.includes('service = "yaos"')) throw new Error("Expected YAOS service binding is missing.");
  await writeFile(KNOWLEDGE_CONFIG, knowledgeConfig);
  await writeFile(YAOS_CONFIG, yaosConfig);

  try {
    // Seed only the local, disposable D1 database from the captured schema,
    // omitting Cloudflare-owned/internal tables which D1's authorizer protects.
    // The production schema snapshot remains documentary and is never executed
    // against any remote database.
    const snapshot = await readFile(join(ROOT, "schema-snapshots/live-d1-schema-2026-10-19.sql"), "utf8");
    const seedSql = snapshot
      .replace(/CREATE TABLE _cf_KV\s*\([\s\S]*?\)\s+WITHOUT ROWID;\s*/i, "")
      .replace(/CREATE TABLE ["']?d1_migrations["']?\s*\([\s\S]*?\);\s*/i, "")
      .replace(/CREATE TABLE d1_migrations_legacy_backup\s*\([\s\S]*?\);\s*/i, "");
    const seedPath = join(stateDir, "schema-local.sql");
    await writeFile(seedPath, seedSql);
    // --local and --persist-to are mandatory on every D1 command.
    await run("npx", [
      ...WRANGLER, "d1", "execute", "knowledge-integration",
      "--local", `--file=${seedPath}`,
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);
    await run("npx", [
      ...WRANGLER, "d1", "execute", "knowledge-integration",
      "--local", "--file=./migrations/pending/0009_yaos_sync_jobs.sql",
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);

    async function startWorker() {
      worker = spawn("npx", [
        ...WRANGLER, "dev",
        "--config", KNOWLEDGE_CONFIG,
        "--config", YAOS_CONFIG,
        "--ip", "127.0.0.1",
        "--port", "8787",
        "--local",
        "--test-scheduled",
        "--persist-to", stateDir,
        "--log-level", "error",
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        },
      });
      const collect = chunk => {
        workerOutput += chunk.toString();
        if (workerOutput.length > 12000) workerOutput = workerOutput.slice(-12000);
      };
      worker.stdout.on("data", collect);
      worker.stderr.on("data", collect);
      await waitFor(async () => {
        try {
          const response = await fetch(HOST + "/health");
          return response.ok;
        } catch { return false; }
      }, "local Knowledge Worker startup");
    }

    async function stopWorker() {
      if (!worker || worker.exitCode !== null) {
        worker = null;
        return;
      }
      const current = worker;
      await new Promise(resolvePromise => {
        current.once("exit", resolvePromise);
        current.kill("SIGTERM");
      });
      worker = null;
    }

    await startWorker();

    // Create -> update -> rename with stable UUID. A job counts as successful
    // only after the Worker verifies the content by reading it back from YAOS.
    let sent = await currentSentCount();
    await importNote(TEST_PATH, noteContent("seed only"), "Integration roundtrip");
    let notes = await getNotes();
    const note = notes.find(item => item.path === TEST_PATH);
    assert.ok(note, "created note is visible in local D1");
    const noteId = note.id;

    sent = await currentSentCount();
    await correctNote(noteId, noteContent("version one"), "Integration roundtrip");
    await waitForSent(sent);

    sent = await currentSentCount();
    await correctNote(noteId, noteContent("version two"), "Integration roundtrip");
    await waitForSent(sent);

    // Path moves are imported through the same UUID reconciliation used by
    // the Obsidian sync endpoint; the following correction enqueues the
    // renamed document and verifies the new path/content in YAOS.
    await importNote(RENAMED_PATH, noteContent("version two"), "Integration roundtrip");
    sent = await currentSentCount();
    await correctNote(noteId, noteContent("version two after rename"), "Integration roundtrip");
    await waitForSent(sent);
    notes = await getNotes();
    assert.ok(notes.some(item => item.id === noteId && item.path === RENAMED_PATH), "rename preserves the D1 note identity");

    // Delete and restore are separate outbox operations and each must be
    // verified by the local YAOS Durable Object before the test continues.
    sent = await currentSentCount();
    const deleted = await request("/api/notes/" + encodeURIComponent(noteId), { method: "DELETE" });
    assert.equal(deleted.deleted, true, "delete endpoint archives the note");
    await waitForSent(sent);

    sent = await currentSentCount();
    const restored = await request("/api/notes/" + encodeURIComponent(noteId) + "/restore", { method: "POST", body: {} });
    assert.equal(restored.restored, true, "restore endpoint restores the note");
    await waitForSent(sent);

    notes = await getNotes();
    assert.ok(notes.some(item => item.id === noteId && item.path === RENAMED_PATH), "restored note remains under renamed path");

    // Prove retry behavior with a controlled, temporary local auth failure.
    // The first attempt must remain pending; after restoring the local YAOS
    // token and restarting both local Workers, the scheduled drain must send it.
    const sentBeforeRetry = await currentSentCount();
    const statusBeforeRetry = await request("/sync/status");
    const pendingBeforeRetry = statusBeforeRetry.outbox.pending || 0;
    await stopWorker();
    const invalidYaosConfig = yaosConfig.replace(
      `SYNC_TOKEN = "${TOKEN}"`,
      'SYNC_TOKEN = "integration-intentionally-invalid-token"',
    );
    assert.notEqual(invalidYaosConfig, yaosConfig, "can prepare temporary invalid YAOS token");
    await writeFile(YAOS_CONFIG, invalidYaosConfig);
    await startWorker();
    await correctNote(noteId, noteContent("retry after temporary YAOS auth failure"), "Integration roundtrip");
    await waitFor(async () => {
      const status = await request("/sync/status");
      return (status.outbox.pending || 0) > pendingBeforeRetry;
    }, "failed YAOS auth attempt to return job to pending");
    await stopWorker();
    await writeFile(YAOS_CONFIG, yaosConfig);
    await startWorker();
    await waitFor(async () => {
      try {
        await triggerDrain();
        const status = await request("/sync/status");
        return status.outbox?.sent > sentBeforeRetry;
      } catch {
        return false;
      }
    }, "outbox job to retry after YAOS auth is restored", 30000);

    // Simulate a real independent YAOS edit after the last verified write.
    // The next Knowledge correction must be rejected as a permanent conflict,
    // not overwrite the remote document or mark the job as sent.
    await mutateYaosNote(RENAMED_PATH, "\\n\\nexternal YAOS edit", clientPath);
    const deadBeforeConflict = await currentDeadCount();
    await correctNote(noteId, noteContent("stale correction must not overwrite YAOS"), "Integration roundtrip");
    await waitFor(async () => (await currentDeadCount()) > deadBeforeConflict, "remote content conflict to be rejected");
    console.log("PASS: isolated local D1 -> Knowledge Worker -> YAOS Worker/DO integration: create, update, rename, delete, restore, conflict refusal.");
  } finally {
    if (worker && worker.exitCode === null) {
      const current = worker;
      await new Promise(resolvePromise => {
        current.once("exit", resolvePromise);
        current.kill("SIGTERM");
      });
    }
    await rm(KNOWLEDGE_CONFIG, { force: true });
    await rm(YAOS_CONFIG, { force: true });
    await rm(clientPath, { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
