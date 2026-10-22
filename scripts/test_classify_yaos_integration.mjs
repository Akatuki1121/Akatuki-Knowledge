import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const classifier = fileURLToPath(new URL("./classify_yaos_integration.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "yaos-integration-classifier-"));
const output = join(dir, "github-output");
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };

function git(...args) {
  return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
}

function classify(base, head, sourceChanged = "true") {
  return execFileSync(process.execPath, [classifier], {
    cwd: dir,
    env: { ...env, BASE_SHA: base, HEAD_SHA: head, SOURCE_CHANGED: sourceChanged, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
}

try {
  git("init", "-q");
  git("config", "user.name", "CI classifier test");
  git("config", "user.email", "ci-classifier@example.invalid");
  // The classifier intentionally targets src/index.js, matching the real repository layout.
  await (await import("node:fs/promises")).mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.js"), 'export const reply = "hello";\n');
  git("add", ".");
  git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD");

  await writeFile(join(dir, "src", "index.js"), 'export const reply = "hello there";\n');
  git("add", ".");
  git("commit", "-qm", "unrelated reply text");
  const feature = git("rev-parse", "HEAD");
  await writeFile(output, "");
  classify(baseline, feature);
  assert.match(await readFile(output, "utf8"), /required=false/, "unrelated source change should skip YAOS E2E");

  await writeFile(join(dir, "src", "index.js"), [
    "async function mutateNote() {",
    '  await enqueueSyncJob(env, "notes", id, "upsert");',
    "  const shouldSend = true;",
    "  return shouldSend;",
    "}",
    "",
  ].join("\n"));
  git("add", ".");
  git("commit", "-qm", "sync change");
  const sync = git("rev-parse", "HEAD");
  await writeFile(join(dir, "src", "index.js"), [
    "async function mutateNote() {",
    '  await enqueueSyncJob(env, "notes", id, "upsert");',
    "  const shouldSend = false;",
    "  return shouldSend;",
    "}",
    "",
  ].join("\n"));
  git("add", ".");
  git("commit", "-qm", "change sync control flow");
  const controlFlow = git("rev-parse", "HEAD");
  await writeFile(output, "");
  classify(sync, controlFlow);
  assert.match(await readFile(output, "utf8"), /required=true/, "control-flow changes inside sync context must run YAOS E2E");

  await writeFile(output, "");
  classify("", sync);
  assert.match(await readFile(output, "utf8"), /required=true/, "unknown diff must fail closed");

  await writeFile(output, "");
  classify("", "", "false");
  assert.match(await readFile(output, "utf8"), /required=false/, "non-source changes should not trigger source classifier");
  console.log("YAOS integration classifier tests passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
