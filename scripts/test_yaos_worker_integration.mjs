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
import { createHash, randomUUID } from "node:crypto";
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
const TEST_STARTED_AT = Date.now();
function markPhase(label) {
  console.log(`[integration timing +${((Date.now() - TEST_STARTED_AT) / 1000).toFixed(1)}s] ${label}`);
}

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

async function stopProcessTree(child) {
  if (!child?.pid) return;

  const waitForExit = () => new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    child.once("exit", resolvePromise);
  });

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([waitForExit(), delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([waitForExit(), delay(1000)]);
    }
    return;
  }

  // The npx parent can exit before Wrangler's descendants. Check the process
  // group itself rather than treating the parent exit as proof of full cleanup.
  const signalTree = signal => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  };
  const waitForGroupExit = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists() && Date.now() < deadline) await delay(100);
    return !groupExists();
  };

  signalTree("SIGTERM");
  if (!(await waitForGroupExit(3000))) {
    signalTree("SIGKILL");
    await waitForGroupExit(1000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([waitForExit(), delay(1000)]);
  }
}

async function triggerDrain() {
  const response = await fetch(HOST + "/__scheduled?cron=0+*+*+*+*", {
    signal: AbortSignal.timeout(5000),
  });
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

async function latestOutboxFailure(stateDir) {
  const queryPath = join(stateDir, "outbox-failure.sql");
  await writeFile(queryPath, [
    "SELECT status, attempts, last_error, payload_json FROM yaos_sync_jobs ORDER BY job_id DESC LIMIT 1;",
    "SELECT id, path, content FROM notes;",
  ].join("\n"));
  return await run("npx", [
    ...WRANGLER, "d1", "execute", "knowledge-integration",
    "--local", `--file=${queryPath}`,
    "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
  ]);
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
const idToText = doc.getMap("idToText");
const meta = doc.getMap("meta");
const provider = new YSyncProvider(host, ${JSON.stringify(VAULT_ID)}, doc, {
  prefix: ${JSON.stringify("/__integration/yaos/vault/sync/" + encodeURIComponent(VAULT_ID))},
  params: { token: ${JSON.stringify(TOKEN)}, schemaVersion: "3" },
  WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
  // Register sync/error listeners before opening the socket to avoid missing
  // the initial sync event on a fast local Worker.
  connect: false,
});
let finished = false;
let lastProviderStatus = "not reported";
function done(code) {
  if (finished) return;
  finished = true;
  provider.destroy();
  doc.destroy();
  process.exitCode = code;
}
provider.on("status", event => {
  lastProviderStatus = event?.status ?? JSON.stringify(event);
  console.error("YAOS edit client status: " + lastProviderStatus);
});
provider.on("connection-error", error => {
  console.error("YAOS edit client connection error: " + String(error));
});
const timeout = setTimeout(() => {
  console.error("YAOS edit client timed out; last provider status: " + lastProviderStatus);
  done(1);
}, 10000);
provider.on("sync", synced => {
  if (!synced || finished) return;
  const matches = Array.from(meta.entries()).filter(([, value]) => {
    const notePath = value instanceof Y.Map
      ? value.get("path")
      : value && typeof value === "object" ? value.path : null;
    return notePath === ${JSON.stringify(path)};
  });
  const id = matches.length === 1 ? matches[0][0] : null;
  const text = id && idToText.get(id);
  if (!text) {
    console.error("YAOS lookup failed: " + JSON.stringify({
      path: ${JSON.stringify(path)},
      metadataEntries: meta.size,
      textEntries: idToText.size,
      pathMatches: matches.length,
    }));
    clearTimeout(timeout);
    done(1);
    return;
  }
  if (${JSON.stringify(suffix)} === null) {
    console.error("YAOS current content: " + JSON.stringify(text.toString()));
    clearTimeout(timeout);
    done(0);
    return;
  }
  text.insert(text.length, ${JSON.stringify(suffix)});
  setTimeout(() => { clearTimeout(timeout); done(0); }, 500);
});
void provider.connect();
`;
  await writeFile(clientPath, client);
  await run(process.execPath, [clientPath], { cwd: YAOS_SERVER });
}

async function importNote(path, content, title, fileId) {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const result = await request("/api/sync", {
    method: "POST",
    body: {
      notes: [{ fileId, path, content, title }],
      observations: [{ fileId, path, deleted: false, contentHash, legacyId: null }],
      observationComplete: true,
    },
  });
  assert.equal(result.ok, true, "sync endpoint accepts a complete fileId observation");
  return result;
}

async function seedLocalNote(stateDir, path, content, title) {
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const syncUuid = randomUUID();
  const contentHash = createHash("sha256").update(content).digest("hex");
  const now = new Date().toISOString();
  const sql = "INSERT INTO notes (id, path, sync_uuid, title, content, content_hash, imported_at, updated_at, tags_json, ai_allowed, sensitivity, review_state, knowledge_type, knowledge_scope) VALUES ("
    + [path, path, syncUuid, title, content, contentHash, now, now, "[]", 0, "unknown", "ready", "unknown", "project"].map(literal).join(", ")
    + ");";
  const sqlPath = join(stateDir, "seed-note.sql");
  await writeFile(sqlPath, sql);
  try {
    await run("npx", [...WRANGLER, "d1", "execute", "knowledge-integration", "--local", `--file=${sqlPath}`, "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir]);
  } finally {
    await rm(sqlPath, { force: true });
  }
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
  return `# Integration roundtrip\\n\\n${text}\\n`;
}

async function main() {
  markPhase("開始");
  const stateDir = await mkdtemp(join(tmpdir(), "knowledge-yaos-e2e-"));
  let worker;
  let workerOutput = "";
  const clientPath = join(YAOS_SERVER, `.knowledge-integration-client-${UUID}.mjs`);
  const originalKnowledge = await readFile(join(ROOT, "wrangler.toml"), "utf8");
  const originalYaos = await readFile(YAOS_WRANGLER, "utf8");

  const knowledgeConfig = `name = "akatuki-knowledge-integration"
main = "scripts/yaos-integration-proxy.mjs"
compatibility_date = "2026-10-17"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "knowledge-integration"
database_id = "00000000-0000-0000-0000-000000000001"

[triggers]
crons = ["0 * * * *"]

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
INTEGRATION_TEST = "true"
# Shorter settle windows are safe here because the integration suite uses local Workers only.
SYNC_IDLE_AFTER_MS = 500
SYNC_PUSH_SETTLE_MS = 500

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
      "--local", "--file=./migrations/0009_yaos_sync_jobs.sql",
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);
    await run("npx", [
      ...WRANGLER, "d1", "execute", "knowledge-integration",
      "--local", "--file=./migrations/0013_agent_memory_metadata.sql",
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);
    await run("npx", [
      ...WRANGLER, "d1", "execute", "knowledge-integration",
      "--local", "--file=./migrations/0014_agent_memory_jobs.sql",
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);
    await run("npx", [
      ...WRANGLER, "d1", "execute", "knowledge-integration",
      "--local", "--file=./migrations/pending/0015_yaos_file_identity_map.sql",
      "--config", KNOWLEDGE_CONFIG, "--persist-to", stateDir,
    ]);
    markPhase("ローカルD1の準備完了");

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
        // Keep Wrangler and its descendants in one process group so cancellation
        // can terminate the whole local test stack, not just the npx wrapper.
        detached: process.platform !== "win32",
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
      try {
        await waitFor(async () => {
          try {
            const response = await fetch(HOST + "/health");
            return response.ok;
          } catch { return false; }
        }, "local Knowledge Worker startup");
      } catch (error) {
        throw new Error(`${error.message}\n${workerOutput}`);
      }
    }

    async function stopWorker() {
      await stopProcessTree(worker);
      worker = null;
    }

    await startWorker();
    markPhase("Knowledge Worker起動完了");

    // Create -> update -> rename with stable UUID. A job counts as successful
    // only after the Worker verifies the content by reading it back from YAOS.
    await seedLocalNote(stateDir, TEST_PATH, noteContent("seed only"), "Integration roundtrip");
    let notes = await getNotes();
    const note = notes.find(item => item.path === TEST_PATH);
    assert.ok(note, "created note is visible in local D1");
    const noteId = note.id;

    let sent = await currentSentCount();
    await correctNote(noteId, noteContent("version one"), "Integration roundtrip");
    await waitForSent(sent);

    sent = await currentSentCount();
    await correctNote(noteId, noteContent("version two"), "Integration roundtrip");
    await waitForSent(sent);

    // Obtain the stable YAOS fileId created by the outbox and use it for
    // the incoming rename observation; no identifier is written to note content.
    const identity = await request("/sync/identity-map?noteId=" + encodeURIComponent(noteId));
    assert.equal(identity.ok, true, "D1 note has an inspectable identity mapping");
    assert.ok(identity.mapping?.file_id, "read-back persisted the stable YAOS fileId");
    await importNote(RENAMED_PATH, noteContent("version two"), "Integration roundtrip", identity.mapping.file_id);
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
    markPhase("作成・更新・改名・削除・復元完了");

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
    let retryObservation = null;
    await waitFor(async () => {
      await triggerDrain();
      const status = await request("/sync/status");
      retryObservation = status.outbox;
      return status.outbox?.sent > sentBeforeRetry;
    }, "outbox job to retry after YAOS auth is restored", 30000).catch(async error => {
      await mutateYaosNote(RENAMED_PATH, null, clientPath).catch(diagnosticError => {
        console.error("YAOS content diagnostic failed: " + String(diagnosticError));
      });
      return latestOutboxFailure(stateDir).then(diagnostic => {
        throw new Error(`${error.message}; last outbox status: ${JSON.stringify(retryObservation)}; latest job: ${diagnostic.slice(-2000)}`);
      });
    });
    markPhase("認証失敗後の再試行完了");

    // The test-only proxy routes this client through the live YAOS service
    // binding so it edits the same Durable Object used by the Knowledge Worker.
    await mutateYaosNote(RENAMED_PATH, "\\n\\nexternal YAOS edit", clientPath);
    const deadBeforeConflict = await currentDeadCount();
    await correctNote(noteId, noteContent("stale correction must not overwrite YAOS"), "Integration roundtrip");
    await waitFor(async () => (await currentDeadCount()) > deadBeforeConflict, "remote content conflict to be rejected");
    markPhase("競合拒否の検証完了");
    console.log("PASS: isolated local D1 -> Knowledge Worker -> YAOS Worker/DO integration: create, update, rename, delete, restore, retry, conflict refusal.");
  } finally {
    await stopProcessTree(worker);
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
