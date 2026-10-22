import assert from "node:assert/strict";
import { checks, selectChecks } from "./check-groups.mjs";

const names = checks.map(([name]) => name);
assert.equal(new Set(names).size, names.length, "check names must be unique");
const core = new Set(selectChecks(["--core-only"]).map(([name]) => name));
const agent = new Set(selectChecks(["--agent-only"]).map(([name]) => name));
const sync = new Set(selectChecks(["--sync-only"]).map(([name]) => name));
const all = new Set(selectChecks([]).map(([name]) => name));
assert.equal(all.size, names.length, "the full suite includes every check");
assert.ok(!core.has("sync-outbox"), "sync-only checks stay out of core");
assert.ok(!core.has("agent-tool-loop"), "agent checks stay out of core");
assert.ok(!agent.has("sync-identity"), "sync-only checks stay out of agent group");
assert.ok(!sync.has("agent-tool-loop"), "agent checks stay out of sync group");
for (const [name] of checks) {
  assert.ok(core.has(name) || agent.has(name) || sync.has(name), `Check is not assigned to any group: ${name}`);
}
assert.ok(core.has("check-group-coverage"), "group coverage check runs in core");
assert.ok(agent.has("sync-telegram-agent-notifications"), "Telegram agent notification tests run with agent checks");
assert.ok(sync.has("sync-telegram-agent-notifications"), "Telegram sync notification tests run with sync checks");
assert.ok(core.has("node-tests"), "shared Node tests run in core");
assert.ok(sync.has("sync-outbox"), "outbox unit tests run in sync group");
assert.ok(agent.has("agent-tool-loop"), "agent tests run in agent group");
console.log(`Check group coverage passed (${names.length} checks).`);
