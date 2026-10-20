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
const LOG = DIR + "\\staging-run.log";
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

async function main() {
  const s0 = await status();
  log("baseline outbox " + JSON.stringify(s0));
  record("0 baseline: outbox migrated, empty", s0.ok === true && s0.pending + s0.processing + s0.sent + s0.dead === 0, JSON.stringify(s0));
  const d0 = await yaosClient(null);
  record("0 baseline: staging YAOS vault empty", Object.keys(d0.paths).length === 0, "paths=" + Object.keys(d0.paths).length);

  // 1 create (D1 row via inbound import; outbox events come from mutation routes)
  await importNote(P1, "seed only");
  let ns = await notes(); const note = ns.find((n) => n.path === P1);
  record("1 create: note row in staging D1", !!note, note ? "id=" + note.id : "missing");
  const id = note.id;

  let prev = (await status()).sent;
  await correct(id, "version one"); await waitSent(prev, "v1");
  let d = await yaosClient(null); let y = findByPath(d, P1);
  record("1 create->YAOS: verified in YAOS", !!y && y.text.includes("version one"), `path=${P1} yaosId=${y?.id} meta=${JSON.stringify(y?.meta)}`);

  prev = (await status()).sent;
  await correct(id, "version two"); await waitSent(prev, "v2");
  d = await yaosClient(null); y = findByPath(d, P1);
  record("2 update: YAOS content updated", !!y && y.text.includes("version two") && !y.text.includes("version one"), `yaosText=${JSON.stringify(y?.text)}`);

  await importNote(P2, "version two");
  prev = (await status()).sent;
  await correct(id, "version two after rename"); await waitSent(prev, "rename");
  ns = await notes(); const renamed = ns.find((n) => n.id === id);
  d = await yaosClient(null); const yNew = findByPath(d, P2);
  record("3 rename: D1 identity kept, YAOS at new path", renamed?.path === P2 && !!yNew && yNew.text.includes("after rename"), `d1Path=${renamed?.path} yaosOld=${JSON.stringify(d.paths[P1] ?? null)} yaosNew=${yNew?.id} yaosMeta=${JSON.stringify(yNew?.meta)}`);

  prev = (await status()).sent;
  const del = await req(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await waitSent(prev, "delete");
  d = await yaosClient(null); const yDel = findByPath(d, P2);
  record("4 delete: D1 archived + YAOS tombstone", del.deleted === true && (!yDel || /delet/i.test(JSON.stringify(yDel.meta))), `api=${JSON.stringify(del)} yaosMeta=${JSON.stringify(yDel?.meta ?? null)} pathPresent=${!!yDel}`);

  prev = (await status()).sent;
  const res = await req(`/api/notes/${encodeURIComponent(id)}/restore`, { method: "POST", body: {} });
  await waitSent(prev, "restore");
  d = await yaosClient(null); const yRes = findByPath(d, P2);
  record("5 restore: D1 restored + YAOS live again", res.restored === true && !!yRes && yRes.text.includes("after rename"), `api=${JSON.stringify(res)} yaosMeta=${JSON.stringify(yRes?.meta)}`);

  // 6 retry after temporary YAOS auth failure
  const before = await status();
  putSecret("SYNC_TOKEN", "staging-intentionally-invalid-" + randomUUID(), "yaos-staging");
  log("yaos-staging SYNC_TOKEN temporarily invalid; waiting for deployment");
  await delay(12000);
  await correct(id, "retry after temporary YAOS auth failure");
  let failedObserved = null;
  try { failedObserved = await waitFor(async () => { const s = await status(); return s.pending > before.pending ? s : (s.sent > before.sent ? { sentEarly: true, ...s } : false); }, "job back to pending", 40000); } catch (e) { failedObserved = { error: String(e) }; }
  const trulyFailed = failedObserved && !failedObserved.sentEarly && !failedObserved.error;
  record("6a retry: failed delivery stays pending (not lost)", !!trulyFailed, JSON.stringify(failedObserved));
  putSecret("SYNC_TOKEN", cfg.SYNC_TOKEN, "yaos-staging");
  log("yaos-staging SYNC_TOKEN restored; waiting for deployment + backoff");
  await delay(15000);
  const sentBeforeRetry = (await status()).sent;
  await correct(id, "retry resolved");
  try {
    const s = await waitFor(async () => { const x = await status(); return x.sent >= sentBeforeRetry + (trulyFailed ? 2 : 1) && x.pending === 0 ? x : false; }, "pending job retried and sent", 90000);
    d = await yaosClient(null); const yR = findByPath(d, P2);
    record("6b retry: pending job delivered after auth restored", !!yR && yR.text.includes("retry resolved"), JSON.stringify(s));
  } catch (e) { record("6b retry: pending job delivered after auth restored", false, String(e)); }

  // 7 independent Vault edit -> conflict refusal
  const deadBefore = (await status()).dead || 0;
  d = await yaosClient({ path: P2, suffix: "\n\nexternal YAOS edit" });
  const sentBeforeConflict = (await status()).sent;
  await correct(id, "stale correction must not overwrite YAOS");
  try {
    const s = await waitFor(async () => { const x = await status(); return (x.dead || 0) > deadBefore ? x : false; }, "conflict job dead-lettered", 60000);
    d = await yaosClient(null); const yC = findByPath(d, P2);
    record("7 conflict: independent Vault edit not overwritten", !!yC && yC.text.includes("external YAOS edit") && !yC.text.includes("stale correction") && s.sent === sentBeforeConflict, JSON.stringify(s) + ` yaosText=${JSON.stringify(yC?.text)}`);
  } catch (e) { record("7 conflict: independent Vault edit not overwritten", false, String(e)); }

  log("final outbox " + JSON.stringify(await status()));
  log("noteId=" + id + " vaultId=" + cfg.VAULT_ID);
  writeFileSync(DIR + "\\staging-results.json", JSON.stringify({ noteId: id, results }, null, 2));
}
main().then(() => { const bad = results.filter((r) => !r.ok); log(`DONE ${results.length - bad.length}/${results.length} passed`); process.exitCode = bad.length ? 1 : 0; }).catch((e) => { log("FATAL " + String(e)); writeFileSync(DIR + "\\staging-results.json", JSON.stringify({ fatal: String(e), results }, null, 2)); process.exitCode = 2; });
