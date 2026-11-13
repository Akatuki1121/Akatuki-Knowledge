#!/usr/bin/env node
/**
 * Local premise check for the diff pull path (method 2, stage 2).
 *
 * The design rests on one unverified premise: that a sync peer answers a
 * non-empty state vector with only the diff. YAOS itself is not in this
 * repository, so this script stands up a standards-compliant y-protocols
 * peer built from the very Yjs copy bundled into src/index.js, wires it
 * behind a fake YAOS fetch, and drives the real YjsClientDO (imported
 * from a temp copy of the bundle whose only change is a stubbed
 * "cloudflare:workers" import) through the pull sequence:
 *
 *   1. first diff pull bootstraps from a full read and persists state;
 *   2. a second pull (fresh DO instance, same storage) transfers ~0;
 *   3. one edited file is the only candidate of the next pull;
 *   4. a rename and a tombstone arrive through the same diff path;
 *   5. losing or corrupting the persisted state recovers via a full
 *      read in the same run, and the pull after that is a clean diff.
 *
 * This proves the Akatuki-side machinery against the protocol contract.
 * Whether the production YAOS handler itself honours non-empty vectors
 * is separate and must be confirmed from the production pull records
 * (each record carries the route and the transfer bytes).
 *
 * Not part of `npm run check`: it assembles a harness in a temp dir.
 * Run directly: node scripts/test-sync-diff-premise.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC_DIR = new URL("../src/", import.meta.url).href;
const workdir = await mkdtemp(join(tmpdir(), "ak-diff-premise-"));

try {
  const stubPath = join(workdir, "cloudflare-workers.mjs");
  await writeFile(stubPath, [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    ""
  ].join("\n"));

  let bundle = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  bundle = bundle.replace('from "cloudflare:workers"', `from ${JSON.stringify(pathToFileURL(stubPath).href)}`);
  bundle = bundle.split('from "./').join(`from "${SRC_DIR}`);
  bundle += "\nexport { Doc as __Doc, YText as __YText, YMap as __YMap, encodeStateAsUpdate as __encodeStateAsUpdate, createDecoder as __createDecoder, readVarUint as __readVarUint, readVarUint8Array as __readVarUint8Array, encodeSyncFrame as __encodeSyncFrame };\n";
  const bundlePath = join(workdir, "bundle.mjs");
  await writeFile(bundlePath, bundle);

  const mod = await import(pathToFileURL(bundlePath).href);
  const { YjsClientDO, __Doc, __YText, __YMap, __encodeStateAsUpdate, __createDecoder, __readVarUint, __readVarUint8Array, __encodeSyncFrame } = mod;

  // --- A standards-compliant sync peer holding a small vault -----------
  const serverDoc = new __Doc();
  const sys = serverDoc.getMap("sys");
  sys.set("initialized", true);
  sys.set("schemaVersion", 3);
  const serverMeta = serverDoc.getMap("meta");
  const serverTexts = serverDoc.getMap("idToText");
  serverDoc.getMap("pathToId");

  const FILES = [];
  function addServerFile(fileId, path, content) {
    serverDoc.transact(() => {
      const entry = new __YMap();
      entry.set("path", path);
      serverMeta.set(fileId, entry);
      const text = new __YText();
      text.insert(0, content);
      serverTexts.set(fileId, text);
    });
    FILES.push({ fileId, path });
  }
  const body = (n) => `# Premise note ${n}\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(14)}\n`;
  for (let i = 1; i <= 12; i++) {
    addServerFile(`premiseFile${String(i).padStart(2, "0")}`, `Notes/Premise/Note-${String(i).padStart(2, "0")}.md`, body(i));
  }

  function makeYaosFetch() {
    return async () => {
      const listeners = { message: [], close: [], error: [] };
      const ws = {
        binaryType: "",
        accept() {},
        addEventListener(type, fn) { listeners[type].push(fn); },
        send(data) {
          const bytes = new Uint8Array(data);
          setTimeout(() => {
            const decoder = __createDecoder(bytes);
            const messageType = __readVarUint(decoder);
            const subType = __readVarUint(decoder);
            if (messageType !== 0 || subType !== 0) return;
            const vector = __readVarUint8Array(decoder);
            const update = __encodeStateAsUpdate(serverDoc, vector);
            const frame = __encodeSyncFrame(1, update);
            for (const fn of listeners.message) fn({ data: frame });
          }, 0);
        },
        close() { for (const fn of listeners.close) fn({ code: 1000, reason: "done" }); }
      };
      return { status: 101, webSocket: ws };
    };
  }

  // --- Fake Durable Object storage and D1 -------------------------------
  function makeStorage() {
    const map = new Map();
    return {
      map,
      async get(key) {
        if (Array.isArray(key)) {
          const out = new Map();
          for (const k of key) if (map.has(k)) out.set(k, map.get(k));
          return out;
        }
        return map.get(key);
      },
      async put(a, b) {
        if (a && typeof a === "object") for (const [k, v] of Object.entries(a)) map.set(k, v);
        else map.set(a, b);
      },
      async delete(key) {
        for (const k of Array.isArray(key) ? key : [key]) map.delete(k);
      }
    };
  }
  const fakeDb = {
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async first() { return null; },
        async run() { return { meta: { changes: 0 } }; }
      };
    }
  };
  const storage = makeStorage();
  const ctx = { storage };
  const env = { YAOS: { fetch: makeYaosFetch() }, VAULT_ID: "premise-vault", YAOS_TOKEN: "premise-token", DB: fakeDb, SYNC_IDLE_AFTER_MS: "25" };

  const pull = async (client) => {
    const res = await client.fetch(new Request("https://internal/changes-diff"));
    const data = await res.json();
    assert.equal(res.status, 200, `changes-diff responds 200: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };

  // 1. Bootstrap: no persisted state, so the diff request reads in full.
  const first = new YjsClientDO(ctx, env);
  const boot = await pull(first);
  assert.equal(boot.ok, true);
  assert.equal(boot.route, "full", "the first diff pull bootstraps with a full read");
  assert.equal(boot.notes.length, 12, "all twelve files are candidates against an empty D1");
  assert.ok(boot.transfer.bytes > 4000, `the bootstrap transfer is the whole vault (got ${boot.transfer.bytes})`);
  assert.equal(boot.observationComplete, true);
  assert.ok(storage.map.has("vault_pull_state"), "the pull persisted its intake state");

  // 2. Second pull, fresh instance over the same storage: ~0 transfer.
  const second = new YjsClientDO(ctx, env);
  const quiet = await pull(second);
  assert.equal(quiet.route, "diff");
  assert.equal(quiet.notes.length, 0, "nothing is queued when nothing changed");
  assert.equal(quiet.same, 12, "every file is carried by the index");
  assert.equal(quiet.observations.length, 12, "the observation still covers the whole vault");
  assert.equal(quiet.observationComplete, true);
  assert.ok(quiet.transfer.bytes < 32, `the no-change diff transfer is ~0 (got ${quiet.transfer.bytes} bytes)`);
  console.log(`premise: bootstrap transfer ${boot.transfer.bytes} bytes -> second pull ${quiet.transfer.bytes} bytes`);

  const statusRes = await second.fetch(new Request("https://internal/status"));
  const status = await statusRes.json();
  assert.equal(status.lastPullRecord.route, "diff", "the pull record names the route");
  assert.ok(status.lastPullRecord.bytes < 32, "the pull record carries the transfer size");

  // 3. One edit: only that file is read, hashed, and queued.
  const edited = FILES[2];
  serverDoc.transact(() => {
    const text = serverTexts.get(edited.fileId);
    text.delete(0, text.length);
    text.insert(0, `# Premise note 3, edited\n\n${"Edited body. ".repeat(20)}\n`);
  });
  const afterEdit = await pull(second);
  assert.equal(afterEdit.route, "diff");
  assert.equal(afterEdit.notes.length, 1, "only the edited file is queued");
  assert.equal(afterEdit.notes[0].path, edited.path);
  assert.equal(afterEdit.differCount, 1);
  assert.ok(afterEdit.transfer.bytes < boot.transfer.bytes / 3, `the edit diff stays small (got ${afterEdit.transfer.bytes})`);

  // 4. A rename and a tombstone travel the same diff path.
  const renamed = FILES[3];
  const tombstoned = FILES[4];
  serverDoc.transact(() => {
    serverMeta.get(renamed.fileId).set("path", "Notes/Premise/Renamed-04.md");
    serverMeta.get(tombstoned.fileId).set("deletedAt", 1730000000000);
  });
  const afterMove = await pull(second);
  assert.equal(afterMove.route, "diff");
  const renamedObservation = afterMove.observations.find((o) => o.fileId === renamed.fileId);
  assert.equal(renamedObservation.path, "Notes/Premise/Renamed-04.md", "the rename is observed at the new path");
  const deletedObservation = afterMove.observations.find((o) => o.fileId === tombstoned.fileId);
  assert.equal(deletedObservation.deleted, true, "the tombstone is observed as a deletion");
  assert.equal(afterMove.notes.length, 1, "the rename is queued as the only candidate");
  assert.equal(afterMove.notes[0].path, "Notes/Premise/Renamed-04.md");

  // 5a. Losing the state meta record bootstraps a full read again.
  storage.map.delete("vault_pull_state");
  const reboot = await pull(second);
  assert.equal(reboot.route, "full", "a missing state record falls back to a full read");
  assert.equal(reboot.notes.length, 11, "the eleven live files are candidates again");

  // 5b. Corrupting the stored Doc state recovers in the same run, and the
  // pull after the recovery is a clean diff again.
  const chunkKey = [...storage.map.keys()].find((k) => k.includes("_chunk_0"));
  assert.ok(chunkKey, "the persisted state has chunks");
  const original = storage.map.get(chunkKey);
  storage.map.set(chunkKey, new Uint8Array(original.byteLength).fill(0xff));
  const recovered = await pull(second);
  assert.equal(recovered.ok, true, "a corrupted state does not fail the pull");
  assert.ok(recovered.route === "full_fallback" || recovered.route === "full", `the corrupted state recovers through a full read (got ${recovered.route})`);
  assert.equal(recovered.notes.length, 11);
  const clean = await pull(second);
  assert.equal(clean.route, "diff");
  assert.equal(clean.notes.length, 0);
  assert.ok(clean.transfer.bytes < 32, `the recovered state diffs cleanly (got ${clean.transfer.bytes} bytes)`);

  // 6. Cap overflow digests across the full -> diff handover: a fresh
  // state bootstraps against 36 live files, the per-run cap (20) queues
  // the first batch, and the following diff pull queues the rest instead
  // of mistaking them for settled.
  for (let i = 13; i <= 37; i++) {
    addServerFile(`premiseFile${String(i).padStart(2, "0")}`, `Notes/Premise/Note-${String(i).padStart(2, "0")}.md`, body(i));
  }
  const storage2 = makeStorage();
  const third = new YjsClientDO({ storage: storage2 }, env);
  const capped = await pull(third);
  assert.equal(capped.route, "full");
  assert.equal(capped.notes.length, 20, "the bootstrap stops at the per-run cap");
  const digested = await pull(third);
  assert.equal(digested.route, "diff");
  assert.equal(digested.notes.length, 16, "the diff pull queues the candidates the cap cut off");
  const settled = await pull(third);
  assert.equal(settled.notes.length, 0, "after digestion the vault is settled");
  assert.ok(settled.transfer.bytes < 32, `the settled pull transfers ~0 (got ${settled.transfer.bytes} bytes)`);

  console.log("Sync diff premise checks passed.");
} finally {
  await rm(workdir, { recursive: true, force: true });
}
