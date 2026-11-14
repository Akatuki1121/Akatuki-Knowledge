#!/usr/bin/env node
/**
 * Local experiment for the diff pull path: why does a no-change diff pull
 * against the production vault still transfer a constant ~15.3 KB?
 *
 * Production pull records (PR #222 probe) showed the constant payload
 * carries 0-1 structs and touches no root shared type, which points at
 * the delete set (tombstone ranges) rather than document content. The
 * young 12-file vault in test-sync-diff-premise.mjs has almost no
 * deletion history, so its second pull is 2 bytes and cannot reproduce
 * the production shape. This script builds a deletion-heavy vault
 * (several writer clients, hundreds of files, thousands of scattered
 * text deletions, whole-file deletions), serves it through the real
 * YjsClientDO diff path, and decomposes every SyncStep2 into its struct
 * section and its delete-set section to see which one survives a
 * complete state vector.
 *
 * Variants covered:
 *   - server keeps the live Doc vs server restored from persisted state
 *     per session vs restored with gc disabled;
 *   - the state vector on the wire is compared against the server's own
 *     state vector, so an Akatuki-side state round-trip loss would show
 *     up as a clock gap instead of being blamed on the peer;
 *   - restoring the client Doc with gc on/off (raw protocol level) must
 *     not change what the server answers.
 *
 * Not part of `npm run check`: it assembles a harness in a temp dir.
 * Run directly: node scripts/test-sync-diff-deleteset.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC_DIR = new URL("../src/", import.meta.url).href;

// --- Vault shape knobs -------------------------------------------------
const DEVICE_COUNT = 4;
const FILES_PER_DEVICE = 70;
const SCATTERED_DELETIONS_PER_FILE = 18;
const FILE_DELETE_EVERY_NTH = 3; // every 3rd file of each device is deleted whole
const TEXT_CHUNKS = 6;
const CHUNK_TEXT = "The quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs. ";

const workdir = await mkdtemp(join(tmpdir(), "ak-diff-deleteset-"));

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
  bundle += "\nexport { Doc as __Doc, YText as __YText, YMap as __YMap, applyUpdate as __applyUpdate, encodeStateAsUpdate as __encodeStateAsUpdate, encodeStateVector as __encodeStateVector, decodeStateVector as __decodeStateVector, getStateVector as __getStateVector, createDeleteSet as __createDeleteSet, createDeleteSetFromStructStore as __createDeleteSetFromStructStore, writeDeleteSet as __writeDeleteSet, writeClientsStructs as __writeClientsStructs, UpdateEncoderV1 as __UpdateEncoderV1, createDecoder as __createDecoder, readVarUint as __readVarUint, readVarUint8Array as __readVarUint8Array, encodeSyncFrame as __encodeSyncFrame };\n";
  const bundlePath = join(workdir, "bundle.mjs");
  await writeFile(bundlePath, bundle);

  const mod = await import(pathToFileURL(bundlePath).href);
  const {
    YjsClientDO, __Doc, __YText, __YMap, __applyUpdate, __encodeStateAsUpdate,
    __encodeStateVector, __decodeStateVector, __getStateVector,
    __createDeleteSetFromStructStore, __writeDeleteSet, __writeClientsStructs,
    __UpdateEncoderV1, __createDecoder, __readVarUint, __readVarUint8Array, __encodeSyncFrame
  } = mod;

  // --- Measurement helpers ------------------------------------------------
  // Byte length of the delete-set section alone, encoded exactly the way
  // writeStateAsUpdate appends it after the struct section.
  const deleteSetBytes = (doc) => {
    const encoder = new __UpdateEncoderV1();
    __writeDeleteSet(encoder, __createDeleteSetFromStructStore(doc.store));
    return encoder.toUint8Array().length;
  };
  // Byte length of the struct section alone for a given target state vector.
  const structSectionBytes = (doc, stateVector) => {
    const encoder = new __UpdateEncoderV1();
    __writeClientsStructs(encoder, doc.store, stateVector);
    return encoder.toUint8Array().length;
  };
  const deleteSetItemCount = (doc) => {
    const ds = __createDeleteSetFromStructStore(doc.store);
    let items = 0;
    let ranges = 0;
    ds.clients.forEach((list) => { items += list.length; for (const item of list) ranges += item.len; });
    return { clients: ds.clients.size, items, deletedClocks: ranges };
  };
  const stateVectorOf = (doc) => __getStateVector(doc.store);

  // --- Build a deletion-heavy vault across several writer clients --------
  const serverDoc = new __Doc();
  serverDoc.getMap("sys").set("initialized", true);
  serverDoc.getMap("sys").set("schemaVersion", 3);
  serverDoc.getMap("meta");
  serverDoc.getMap("idToText");
  serverDoc.getMap("pathToId");

  const syncInto = (from, to) => __applyUpdate(to, __encodeStateAsUpdate(from, __encodeStateVector(to)));
  const syncPair = (a, b) => { syncInto(a, b); syncInto(b, a); syncInto(a, b); };

  const devices = [];
  for (let d = 0; d < DEVICE_COUNT; d++) {
    const device = new __Doc();
    const meta = device.getMap("meta");
    const texts = device.getMap("idToText");
    const pathToId = device.getMap("pathToId");
    device.getMap("sys");
    const files = [];
    for (let i = 0; i < FILES_PER_DEVICE; i++) {
      const fileId = `dev${d}file${String(i).padStart(3, "0")}`;
      const path = `Notes/Heavy/Device${d}/Note-${String(i).padStart(3, "0")}.md`;
      device.transact(() => {
        const entry = new __YMap();
        entry.set("path", path);
        meta.set(fileId, entry);
        const text = new __YText();
        for (let c = 0; c < TEXT_CHUNKS; c++) text.insert(text.length, CHUNK_TEXT);
        texts.set(fileId, text);
        pathToId.set(path, fileId);
      });
      files.push({ fileId, path });
    }
    // Editing history: many small deletions scattered over each text,
    // each in its own transaction and separated by live characters, so
    // the delete set fragments into many ranges instead of merging.
    for (const file of files) {
      const text = texts.get(file.fileId);
      for (let k = 0; k < SCATTERED_DELETIONS_PER_FILE; k++) {
        const block = Math.floor(text.length / (SCATTERED_DELETIONS_PER_FILE + 1));
        const offset = text.length - 1 - k * block - 1;
        if (offset < 1) break;
        device.transact(() => text.delete(offset, 1));
      }
      // A couple of whole-paragraph rewrites (one contiguous range each).
      device.transact(() => {
        text.delete(0, CHUNK_TEXT.length);
        text.insert(0, "Rewritten opening paragraph, replacing what was there before the edit. ");
      });
    }
    devices.push({ doc: device, files });
    syncPair(device, serverDoc);
  }
  // Whole-file deletions, done by the owning device and synced after:
  // the tombstone form (deletedAt), then the entry-removal form.
  let wholeDeleted = 0;
  for (const { doc: device, files } of devices) {
    const meta = device.getMap("meta");
    const texts = device.getMap("idToText");
    const pathToId = device.getMap("pathToId");
    files.forEach((file, i) => {
      if (i % FILE_DELETE_EVERY_NTH !== 0) return;
      wholeDeleted++;
      if (i % (FILE_DELETE_EVERY_NTH * 2) === 0) {
        device.transact(() => meta.get(file.fileId).set("deletedAt", 1730000000000));
      } else {
        device.transact(() => {
          meta.delete(file.fileId);
          texts.delete(file.fileId);
          pathToId.delete(file.path);
        });
      }
    });
    syncPair(device, serverDoc);
  }

  const serverDs = deleteSetItemCount(serverDoc);
  const serverDsBytes = deleteSetBytes(serverDoc);
  const serverSv = stateVectorOf(serverDoc);
  console.log(`vault built: ${DEVICE_COUNT * FILES_PER_DEVICE} files (${wholeDeleted} whole-file deletions), ` +
    `delete set = ${serverDs.items} ranges over ${serverDs.deletedClocks} deleted clocks, ` +
    `${serverDs.clients} clients, ${serverDsBytes} bytes encoded`);
  assert.ok(serverDsBytes > 8000, `the experiment needs a production-scale delete set (got ${serverDsBytes} bytes)`);

  // --- Fake storage / D1 (same fakes as the premise harness) -------------
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

  // Sync peer with wire-level instrumentation: records the state vector
  // the client sent and decomposes the SyncStep2 it answers with.
  function makeInstrumentedFetch(getServerDoc, probe) {
    return async () => {
      const server = getServerDoc();
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
            const svMap = __decodeStateVector(vector);
            const update = __encodeStateAsUpdate(server, vector);
            probe.step1Vector = svMap;
            probe.step2Bytes = update.length;
            probe.step2StructBytes = structSectionBytes(server, svMap);
            probe.step2DsBytes = deleteSetBytes(server);
            const frame = __encodeSyncFrame(1, update);
            for (const fn of listeners.message) fn({ data: frame });
          }, 0);
        },
        close() { for (const fn of listeners.close) fn({ code: 1000, reason: "done" }); }
      };
      return { status: 101, webSocket: ws };
    };
  }

  const pull = async (client) => {
    const res = await client.fetch(new Request("https://internal/changes-diff"));
    const data = await res.json();
    assert.equal(res.status, 200, `changes-diff responds 200: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };

  async function runVariant(label, getServerDoc) {
    const storage = makeStorage();
    const probe = {};
    const env = { YAOS: { fetch: makeInstrumentedFetch(getServerDoc, probe) }, VAULT_ID: "heavy-vault", YAOS_TOKEN: "heavy-token", DB: fakeDb, SYNC_IDLE_AFTER_MS: "25" };
    const ctx = { storage };
    const client = new YjsClientDO(ctx, env);
    const boot = await pull(client);
    assert.equal(boot.route, "full", `${label}: first pull bootstraps`);
    const second = await pull(new YjsClientDO(ctx, env));
    const third = await pull(new YjsClientDO(ctx, env));
    // The state vector the client sent on the quiet pulls must cover the
    // server's store client for client; any gap here would be an
    // Akatuki-side state round-trip loss, not a peer behaviour.
    const svGaps = [];
    serverSv.forEach((clock, clientId) => {
      const sent = probe.step1Vector.get(clientId) || 0;
      if (sent < clock) svGaps.push({ clientId, sent, server: clock });
    });
    console.log(`${label}: bootstrap ${boot.transfer.bytes} bytes -> quiet pull ${second.transfer.bytes} bytes -> next ${third.transfer.bytes} bytes; ` +
      `step2 decomposition on the wire: structs ${probe.step2StructBytes} + delete set ${probe.step2DsBytes} = ${probe.step2StructBytes + probe.step2DsBytes} (frame payload ${probe.step2Bytes}); ` +
      `shape structs=${second.transfer.updateShape.structs}, sv gaps=${JSON.stringify(svGaps)}`);
    return { boot, second, third, probe, svGaps };
  }

  // Variant 1: the server keeps its live Doc across sessions.
  const live = await runVariant("server live doc      ", () => serverDoc);
  // Variant 2: the server is restored from its persisted state per
  // session (a Durable Object that was evicted and reloaded).
  const persistedServerState = __encodeStateAsUpdate(serverDoc);
  const liveResult = await runVariant("server restored      ", () => {
    const restored = new __Doc();
    __applyUpdate(restored, persistedServerState);
    return restored;
  });
  // Variant 3: same reload, but the restored server Doc runs gc=false.
  await runVariant("server restored gc=off", () => {
    const restored = new __Doc({ gc: false });
    __applyUpdate(restored, persistedServerState);
    return restored;
  });

  // The quiet-pull payload is the delete set, in every variant:
  // structs collapse to ~0 while the total stays at the delete-set size.
  for (const [label, run] of [["live", live], ["restored", liveResult]]) {
    assert.equal(run.svGaps.length, 0, `${label}: the client's state vector covers the server store`);
    assert.ok(run.probe.step2StructBytes < 64, `${label}: structs collapse once the vector is complete (got ${run.probe.step2StructBytes})`);
    assert.ok(run.second.transfer.bytes > serverDsBytes * 0.8,
      `${label}: the quiet pull still transfers the delete set (got ${run.second.transfer.bytes}, delete set ${serverDsBytes})`);
    assert.ok(Math.abs(run.third.transfer.bytes - run.second.transfer.bytes) < serverDsBytes * 0.05 + 64,
      `${label}: repeating the pull does not shrink the payload (${run.second.transfer.bytes} -> ${run.third.transfer.bytes})`);
  }

  // Raw-protocol check: restoring the CLIENT doc with gc disabled does
  // not change its state vector, so it cannot change the server's answer.
  const clientGcOn = new __Doc();
  __applyUpdate(clientGcOn, persistedServerState);
  const clientGcOff = new __Doc({ gc: false });
  __applyUpdate(clientGcOff, persistedServerState);
  const svOn = __encodeStateVector(clientGcOn);
  const svOff = __encodeStateVector(clientGcOff);
  assert.deepEqual([...__decodeStateVector(svOff)], [...__decodeStateVector(svOn)], "gc on/off yields the same client state vector");
  const answerOn = __encodeStateAsUpdate(serverDoc, svOn).length;
  const answerOff = __encodeStateAsUpdate(serverDoc, svOff).length;
  assert.equal(answerOn, answerOff, "the server's answer does not depend on the client's gc setting");
  console.log(`client gc on/off: state vectors identical, server answer ${answerOn} bytes either way`);

  // The payload tracks the deletion history: more scattered deletions on
  // the server grow the quiet-pull transfer by the delete-set growth.
  const extra = devices[0].doc;
  const extraText = extra.getMap("idToText").get(devices[0].files[1].fileId);
  const beforeExtra = deleteSetBytes(serverDoc);
  for (let k = 0; k < 300; k++) {
    const offset = extraText.length - 2 - k * 3;
    if (offset < 1) break;
    extra.transact(() => extraText.delete(offset, 1));
  }
  syncPair(extra, serverDoc);
  const afterExtra = deleteSetBytes(serverDoc);
  console.log(`delete-set growth: +300 scattered deletions moved the encoded delete set ${beforeExtra} -> ${afterExtra} bytes`);
  assert.ok(afterExtra > beforeExtra, "the delete set grows with deletion history");

  console.log("Sync diff delete-set experiment done.");
} finally {
  await rm(workdir, { recursive: true, force: true });
}
