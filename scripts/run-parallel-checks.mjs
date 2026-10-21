import { spawn } from "node:child_process";

const checks = [
  ["source-syntax", process.execPath, ["--check", "src/index.js"]],
  ["node-tests", process.execPath, ["--test"]],
  ["sync-contract", process.execPath, ["scripts/check-sync-contract.mjs"]],
  ["sync-identity", process.execPath, ["scripts/test-sync-identity.mjs"]],
  ["sync-conflicts", process.execPath, ["scripts/test-sync-conflicts.mjs"]],
  ["safe-note-id-recovery", process.execPath, ["scripts/test-safe-note-id-recovery.mjs"]],
  ["background-task-policy", process.execPath, ["scripts/test-background-task-policy.mjs"]],
  ["background-task-store", process.execPath, ["scripts/check-background-task-store.mjs"]],
  ["background-task-workflow", process.execPath, ["scripts/check-background-task-workflow.mjs"]],
  ["agent-tasks-migration", "python3", ["scripts/test_agent_tasks_migration.py"]],
  ["agent-task-store-sql", "python3", ["scripts/test_agent_task_store_sql.py"]],
  ["agent-organization", process.execPath, ["scripts/check-agent-organization.mjs"]],
  ["wrangler-config", process.execPath, ["scripts/check-wrangler-config.mjs"]]
];

const selectedChecks = process.argv.includes("--sync-only")
  ? checks.filter(([name]) => name.startsWith("sync-") || name === "safe-note-id-recovery" || name.startsWith("background-task-"))
  : checks;

const limit = Math.max(1, Math.min(4, Number(process.env.CI_CHECK_CONCURRENCY) || 4));
let next = 0;
let failed = false;
const running = new Set();
const results = [];

function launch([name, command, args]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    const prefix = (stream) => {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) console.log(`[${name}] ${line}`);
      });
      stream.on("end", () => {
        if (pending) console.log(`[${name}] ${pending}`);
      });
    };
    prefix(child.stdout);
    prefix(child.stderr);
    child.on("error", (error) => {
      console.error(`[${name}] failed to start: ${error.message}`);
      resolve({ name, code: 1 });
    });
    child.on("close", (code, signal) => {
      const result = { name, code: code ?? 1, signal };
      console.log(`[${name}] ${result.code === 0 ? "PASS" : "FAIL"}`);
      resolve(result);
    });
  });
}

async function worker() {
  while (!failed) {
    const index = next++;
    if (index >= selectedChecks.length) return;
    const promise = launch(selectedChecks[index]).then((result) => {
      running.delete(promise);
      results.push(result);
      if (result.code !== 0) failed = true;
      return result;
    });
    running.add(promise);
    if (running.size >= limit) await Promise.race(running);
  }
}

await Promise.all(Array.from({ length: limit }, () => worker()));
await Promise.all(running);

if (failed || results.some((result) => result.code !== 0)) {
  console.error(`Parallel checks failed: ${results.filter((result) => result.code !== 0).map((result) => result.name).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Parallel checks passed (${results.length} checks, concurrency ${limit}).`);
}
