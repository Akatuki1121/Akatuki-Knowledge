import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Behavioural tests for the adaptive pull cadence and the read-side
// freshness refresh. The functions are extracted from the Worker bundle
// (the established pattern for this repository) and run against a fake
// app_meta store plus stubbed pull collaborators.

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

function sliceFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const plainStart = source.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  const marker = `__name(${name}, "${name}");`;
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, `Could not extract ${name} from the Worker bundle`);
  return source.slice(start, end);
}

function constantValue(name) {
  const match = source.match(new RegExp(`var ${name} = (\\d+);`));
  assert.ok(match, `Could not find constant ${name}`);
  return Number(match[1]);
}

function buildHelpers(globals) {
  const parts = [
    sliceFunction("readVaultPullActivity"),
    sliceFunction("writeVaultPullActivity"),
    sliceFunction("vaultPullChanged"),
    sliceFunction("updateVaultPullActivity"),
    sliceFunction("refreshVaultBeforeRead"),
    sliceFunction("isOnTheHourTick")
  ];
  const factory = new Function(
    ...Object.keys(globals),
    `${parts.join("\n")}\nreturn { readVaultPullActivity, updateVaultPullActivity, refreshVaultBeforeRead, isOnTheHourTick };`
  );
  return factory(...Object.values(globals));
}

function makeAppMetaDb() {
  const store = new Map();
  return {
    store,
    prepare() {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          const value = store.get(values[0]);
          return value === undefined ? null : { value };
        },
        async run() {
          store.set(values[0], values[1]);
          return { meta: { changes: 1 } };
        }
      };
    }
  };
}

const baseGlobals = {
  PULL_ACTIVITY_KEY: "vault_pull_activity",
  ACTIVE_EMPTY_PULL_LIMIT: constantValue("ACTIVE_EMPTY_PULL_LIMIT"),
  READ_REFRESH_STALE_MS: constantValue("READ_REFRESH_STALE_MS")
};

// --- isOnTheHourTick -------------------------------------------------------

{
  const { isOnTheHourTick } = buildHelpers({ ...baseGlobals });
  assert.equal(isOnTheHourTick(Date.UTC(2026, 10, 14, 8, 0, 0)), true, "minute zero is the full-pull tick");
  assert.equal(isOnTheHourTick(Date.UTC(2026, 10, 14, 8, 1, 0)), false);
  assert.equal(isOnTheHourTick(Date.UTC(2026, 10, 14, 8, 59, 0)), false);
  assert.equal(isOnTheHourTick(undefined), false, "an unusable fire time is not the hour tick");
  assert.equal(isOnTheHourTick(NaN), false);
}

// --- updateVaultPullActivity ----------------------------------------------

{
  const db = makeAppMetaDb();
  const env = { DB: db };
  const { readVaultPullActivity, updateVaultPullActivity } = buildHelpers({ ...baseGlobals });

  assert.deepEqual(await readVaultPullActivity(env), { active: true, emptyStreak: 0 }, "no state row means active");

  const quiet = { ok: true, differ: 0, new: 0, created: 0, updated: 0 };
  for (let i = 0; i < baseGlobals.ACTIVE_EMPTY_PULL_LIMIT - 1; i++) {
    await updateVaultPullActivity(env, "diff", quiet);
  }
  let activity = await readVaultPullActivity(env);
  assert.equal(activity.active, true, "still active before the empty limit");
  assert.equal(activity.emptyStreak, baseGlobals.ACTIVE_EMPTY_PULL_LIMIT - 1);

  await updateVaultPullActivity(env, "diff", quiet);
  activity = await readVaultPullActivity(env);
  assert.deepEqual(activity, { active: false, emptyStreak: 0 }, "the limit of empty diff pulls quiets the vault");

  await updateVaultPullActivity(env, "diff", quiet);
  activity = await readVaultPullActivity(env);
  assert.equal(activity.active, false, "a quiet vault stays quiet on empty pulls");

  await updateVaultPullActivity(env, "diff", { ok: true, differ: 0, new: 1, created: 1, updated: 0 });
  activity = await readVaultPullActivity(env);
  assert.deepEqual(activity, { active: true, emptyStreak: 0 }, "an observed change wakes the vault");

  await updateVaultPullActivity(env, "diff", quiet);
  await updateVaultPullActivity(env, "full", quiet);
  activity = await readVaultPullActivity(env);
  assert.equal(activity.emptyStreak, 1, "a no-change full pull does not move the empty streak");

  await updateVaultPullActivity(env, "diff", { ok: false, stage: "read_vault" });
  await updateVaultPullActivity(env, "diff", { ok: true, skipped: "vault_not_initialized" });
  activity = await readVaultPullActivity(env);
  assert.equal(activity.emptyStreak, 1, "failed and skipped pulls do not move the activity state");
  assert.equal(activity.active, true);
}

// --- refreshVaultBeforeRead -------------------------------------------------

function refreshHarness({ diagnostics, claim, pull }) {
  const calls = { pull: [], persisted: [] };
  const helpers = buildHelpers({
    ...baseGlobals,
    readVaultPullDiagnostics: async () => diagnostics,
    claimScheduledPull: async () => claim,
    pullFromVault: async (...args) => {
      calls.pull.push(args);
      if (pull instanceof Error) throw pull;
      return pull;
    },
    persistVaultPullDiagnostics: async (env, summary) => { calls.persisted.push(summary); },
    summarizeVaultPull: (result, error, source) => ({ result, error, source })
  });
  return { helpers, calls };
}

{
  const env = { DB: makeAppMetaDb(), YJS_CLIENT: {} };
  const fresh = refreshHarness({
    diagnostics: { ok: true, recordedAt: new Date().toISOString() },
    claim: { claimed: true },
    pull: { ok: true }
  });
  const outcome = await fresh.helpers.refreshVaultBeforeRead(env, {}, "https://worker.test");
  assert.deepEqual(outcome, { refreshed: false, reason: "fresh" }, "a fresh read does not pull");
  assert.equal(fresh.calls.pull.length, 0);
}

{
  const env = { DB: makeAppMetaDb(), YJS_CLIENT: {} };
  const stale = refreshHarness({
    diagnostics: { ok: true, recordedAt: new Date(Date.now() - 10 * 60000).toISOString() },
    claim: { claimed: true },
    pull: { ok: true, route: "diff", differ: 0, new: 1, created: 1, updated: 0 }
  });
  const outcome = await stale.helpers.refreshVaultBeforeRead(env, {}, "https://worker.test");
  assert.equal(outcome.refreshed, true, "a stale read pulls before serving");
  assert.equal(stale.calls.pull.length, 1);
  assert.equal(stale.calls.pull[0][4], "diff", "the read refresh takes the diff route");
  assert.equal(stale.calls.persisted.length, 1);
  assert.equal(stale.calls.persisted[0].source, "read", "the refresh is recorded as a read-source pull");
  const activity = await stale.helpers.readVaultPullActivity(env);
  assert.deepEqual(activity, { active: true, emptyStreak: 0 }, "a change found by a read wakes the vault");
}

{
  const env = { DB: makeAppMetaDb(), YJS_CLIENT: {} };
  const busy = refreshHarness({
    diagnostics: { ok: false, skipped: "no_pull_recorded" },
    claim: { claimed: false, reason: "cooldown" },
    pull: { ok: true }
  });
  const outcome = await busy.helpers.refreshVaultBeforeRead(env, {}, "https://worker.test");
  assert.deepEqual(outcome, { refreshed: false, reason: "cooldown" }, "the refresh shares the scheduled claim gate");
  assert.equal(busy.calls.pull.length, 0, "no pull runs while another pull holds the claim");
}

{
  const env = { DB: makeAppMetaDb(), YJS_CLIENT: {} };
  const failing = refreshHarness({
    diagnostics: { ok: false, skipped: "no_pull_recorded" },
    claim: { claimed: true },
    pull: new Error("vault unreachable")
  });
  const outcome = await failing.helpers.refreshVaultBeforeRead(env, {}, "https://worker.test");
  assert.deepEqual(outcome, { refreshed: false, reason: "pull_failed" }, "a failed refresh never fails the read");
  assert.equal(failing.calls.persisted.length, 1, "the failed refresh is still recorded");
  assert.equal(failing.calls.persisted[0].source, "read");
  assert.ok(failing.calls.persisted[0].error instanceof Error, "the recording carries the failure");
}

console.log("Sync diff pull cadence and read-refresh checks passed.");
