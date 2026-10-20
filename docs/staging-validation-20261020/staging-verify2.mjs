// Staging-only live verification for PR #14 (Akatuki-Knowledge YAOS event sync).
// Talks ONLY to the staging Workers. Never prints tokens.
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";

const DIR = "C:\\Users\\sou\\AppData\\Local\\Temp\\akatuki-w";
const cfg = JSON.parse(readFileSync(DIR + "\\.stg.json", "utf8").replace(/^\uFEFF/, ""));
const K = "https://akatuki-knowledge-staging.sousou-e1121.workers.dev";
const Yh = "https://yaos-staging.sousou-e1121.workers.dev";
const LOG = DIR + "\\staging-run2.log";
const UUID = randomUUID();
const P1 = "Staging Verify/pr14-roundtrip.md";
const P2 = "Staging Verify/pr14-roundtrip-renamed.md";
const results = [];
writeFileSync(LOG, "");
function log(m) { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(LOG, l + "\n"); }
function record(step, ok, detail) { results.push({ step, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${step} ${detail ? "- " + detail : ""}`); }

async function req(path, { method = "GET", body } = {}) {
  const r = await fetch(K + path, { method, headers: { authorization: `Bearer ${cfg.API_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}: ${t.slice(0, 300)}`);
  return j;
}
const status = async () => (await req("/sync/status")).outbox;
async function waitFor(fn, label, ms = 60000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await delay(1000); }
  throw new Error(`timeout: ${label}; last=${String(last)}`);
}
async function waitSent(prev, label) {
  return waitFor(async () => { const s = await status(); if (s.dead > 0 && label !== "conflict") throw new Error("dead jobs: " + JSON.stringify(s)); return s.sent > prev ? s : false; }, "sent>" + prev + " " + label);
}
const content = (t) => `---\nid: ${UUID}\n---\n# Staging roundtrip\n\n${t}\n`;
async function importNote(path, text) { return req("/api/sync", { method: "POST", body: { notes: [{ path, content: content(text), title: "Staging roundtrip" }] } }); }
async function correct(id, text) { return req(`/api/notes/${encodeURIComponent(id)}/correction`, { method: "POST", body: { content: content(text), title: "Staging roundtrip" } }); }
const notes = async () => (await req("/api/notes?limit=100")).notes;

// Independent YAOS client (separate from the Knowledge Worker). edit=null -> read-only dump.
function yaosClient(edit) {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const pathToId = doc.getMap("pathToId"), idToText = doc.getMap("idToText"), meta = doc.getMap("meta");
    const provider = new YSyncProvider(Yh, cfg.VAULT_ID, doc, { prefix: "/vault/sync/" + encodeURIComponent(cfg.VAULT_ID), params: { token: cfg.SYNC_TOKEN, schemaVersion: "3" }, WebSocketPolyfill: globalThis.WebSocket, connect: false });
    const timer = setTimeout(() => { provider.destroy(); doc.destroy(); reject(new Error("yaos client timeout")); }, 20000);
    provider.on("sync", async (synced) => {
      if (!synced) return;
      await delay(1500);
      if (edit) { const id = pathToId.get(edit.path); const t = id && idToText.get(id); if (!t) { clearTimeout(timer); provider.destroy(); doc.destroy(); return reject(new Error("note not in YAOS at " + edit.path)); } t.insert(t.length, edit.suffix); await delay(1500); }
      const dump = { paths: Object.fromEntries([...pathToId.entries()]), texts: {}, meta: {} };
      for (const [id, t] of idToText.entries()) dump.texts[id] = String(t.toString());
      for (const [id, m] of meta.entries()) dump.meta[id] = m && m.toJSON ? m.toJSON() : m;
      clearTimeout(timer); provider.destroy(); doc.destroy(); resolve(dump);
    });
    void provider.connect();
  });
}
function putSecret(name, value, worker) {
  const r = spawnSync("npx.cmd", ["--yes", "wrangler@4.69.0", "secret", "put", name, "--name", worker], { input: value, cwd: DIR, encoding: "utf8", shell: true });
  if (r.status !== 0) throw new Error(`secret put ${name} failed: ${(r.stdout + r.stderr).slice(-300)}`);
}
const findByPath = (d, p) => { const id = d.paths[p]; return id ? { id, text: d.texts[id], meta: d.meta[id] } : null; };


let DEAD_BASE = 0;
async function waitSent2(prev, label) {
  return waitFor(async () => { const s = await status(); if ((s.dead || 0) > DEAD_BASE) throw new Error("unexpected dead jobs: " + JSON.stringify(s)); return s.sent > prev ? s : false; }, "sent>" + prev + " " + label);
}
const metaOf = (d, id) => (id && d.meta[id]) ? d.meta[id] : null;

async function main() {
  const PB = "Staging Verify/pr14-pass2.md";
  const s0 = await status();
  log("pass2 baseline outbox " + JSON.stringify(s0) + " (job 8 from pass 1 still pending: stale correction)");
  DEAD_BASE = s0.dead || 0;

  await importNote(PB, "B seed");
  const idB = (await notes()).find((n) => n.path === PB).id;
  // This correction's drain also picks up pass-1 job 8 (stale correction vs external edit): expected to dead-letter.
  let prev = s0.sent;
  await correct(idB, "B version one");
  const s1 = await waitFor(async () => { const x = await status(); return x.sent > prev && x.pending === 0 ? x : false; }, "B v1 sent and queue drained", 60000);
  record("P2-0 pass-1 stale correction (job 8) refused by drain, B created", (s1.dead || 0) === DEAD_BASE + 1 && s1.sent === prev + 1, JSON.stringify(s1));
  DEAD_BASE = s1.dead || 0;

  let d = await yaosClient(null);
  const yaosIdB = d.paths[PB];
  record("P2-1 B present in YAOS with meta", !!yaosIdB && /version one/.test(d.texts[yaosIdB] || ""), `yaosId=${yaosIdB} meta=${JSON.stringify(metaOf(d, yaosIdB))}`);

  prev = (await status()).sent;
  const del = await req(`/api/notes/${encodeURIComponent(idB)}`, { method: "DELETE" });
  await waitSent2(prev, "B delete");
  d = await yaosClient(null);
  const mDel = metaOf(d, yaosIdB);
  record("P2-2 delete: tombstone in YAOS meta for the same file id", del.deleted === true && !d.paths[PB] && !!mDel && /delet/i.test(JSON.stringify(mDel)), `pathPresent=${!!d.paths[PB]} metaForId=${JSON.stringify(mDel)} textStillPresent=${yaosIdB in d.texts}`);

  prev = (await status()).sent;
  const res = await req(`/api/notes/${encodeURIComponent(idB)}/restore`, { method: "POST", body: {} });
  await waitSent2(prev, "B restore");
  d = await yaosClient(null);
  const mRes = metaOf(d, d.paths[PB]);
  record("P2-3 restore: live again, tombstone cleared", res.restored === true && !!d.paths[PB] && !/"deleted(At)?":\s*(true|\d+)/i.test(JSON.stringify(mRes)), `yaosId=${d.paths[PB]} sameId=${d.paths[PB] === yaosIdB} meta=${JSON.stringify(mRes)}`);

  // Clean conflict: external edit, then a correction whose baseline predates it, with an empty queue.
  d = await yaosClient({ path: PB, suffix: "\n\nexternal YAOS edit B" });
  const sB = await status();
  await correct(idB, "B stale correction must not overwrite YAOS");
  try {
    const s = await waitFor(async () => { const x = await status(); return (x.dead || 0) > (sB.dead || 0) ? x : false; }, "B conflict dead-lettered", 60000);
    d = await yaosClient(null); const t = d.texts[d.paths[PB]] || "";
    record("P2-4 conflict (clean): independent edit kept, stale write refused", /external YAOS edit B/.test(t) && !/stale correction/.test(t) && s.sent === sB.sent && s.pending === 0, JSON.stringify(s) + ` yaosText=${JSON.stringify(t)}`);
  } catch (e) { record("P2-4 conflict (clean): independent edit kept, stale write refused", false, String(e)); }

  log("final outbox " + JSON.stringify(await status()));
  writeFileSync(DIR + "\\staging-results2.json", JSON.stringify({ noteIdB: idB, results }, null, 2));
}
main().then(() => { const bad = results.filter((r) => !r.ok); log(`DONE ${results.length - bad.length}/${results.length} passed`); process.exitCode = bad.length ? 1 : 0; }).catch((e) => { log("FATAL " + String(e)); writeFileSync(DIR + "\\staging-results2.json", JSON.stringify({ fatal: String(e), results }, null, 2)); process.exitCode = 2; });
