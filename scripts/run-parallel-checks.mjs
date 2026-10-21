import { spawn } from "node:child_process";

const checks = [
  ["sync-contract", "scripts/check-sync-contract.mjs"],
  ["sync-identity", "scripts/test-sync-identity.mjs"],
  ["sync-conflicts", "scripts/test-sync-conflicts.mjs"],
  ["safe-note-id-recovery", "scripts/test-safe-note-id-recovery.mjs"],
  ["background-task-policy", "scripts/test-background-task-policy.mjs"],
  ["background-task-store", "scripts/check-background-task-store.mjs"],
  ["background-task-workflow", "scripts/check-background-task-workflow.mjs"]
];

const limit = Math.max(1, Math.min(4, Number(process.env.CI_CHECK_CONCURRENCY) || 4));
let next = 0;
let failed = false;
const running = new Set();

function launch([name, file]) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
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
    if (index >= checks.length) return;
    const promise = launch(checks[index]).then((result) => {
      running.delete(promise);
      if (result.code !== 0) failed = true;
      return result;
    });
    running.add(promise);
    if (running.size >= limit) await Promise.race(running);
  }
}

await Promise.all(Array.from({ length: limit }, () => worker()));
const results = await Promise.all(running);
if (failed || results.some((result) => result.code !== 0)) {
  console.error("Parallel checks failed.");
  process.exitCode = 1;
} else {
  console.log(`Parallel checks passed (${checks.length} checks, concurrency ${limit}).`);
}
