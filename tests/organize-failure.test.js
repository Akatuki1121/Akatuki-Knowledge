import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

function extractFunction(name, { async = false } = {}) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the Worker source`);
  const end = source.indexOf(`\n}\n__name(${name},`, start);
  assert.notEqual(end, -1, `${name} must be followed by __name()`);
  return `${async ? "async " : ""}${source.slice(start, end + 2)}`;
}

const limitMatch = source.match(/var D1_LIKE_PATTERN_MAX_BYTES = (\d+);/);
assert.ok(limitMatch, "D1_LIKE_PATTERN_MAX_BYTES must exist");

const context = vm.createContext({ TextEncoder, SyntaxError, __name: (fn) => fn });
vm.runInContext(
  [
    `var D1_LIKE_PATTERN_MAX_BYTES = ${limitMatch[1]};`,
    extractFunction("classifyOperationalFailure"),
    extractFunction("describeOrganizeFailure"),
    extractFunction("linkRelatedNotes", { async: true }),
  ].join("\n"),
  context,
);

function fakeEnv(bound) {
  return {
    DB: {
      prepare: () => ({
        bind: (...args) => {
          bound.push(...args);
          return { all: async () => ({ results: [] }), run: async () => ({}) };
        },
      }),
    },
  };
}

test("failure log keeps stage, status and SQLite code but never the error message", () => {
  const error = new Error("quota exceeded for note body: 個人メモの本文");
  error.httpStatus = 429;
  error.apiStatus = "RESOURCE_EXHAUSTED";
  const logged = JSON.stringify(context.describeOrganizeFailure("gemini_call", "telegram", error));
  assert.ok(logged.includes('"stage":"gemini_call"'));
  assert.ok(logged.includes('"httpStatus":429'));
  assert.ok(logged.includes('"apiStatus":"RESOURCE_EXHAUSTED"'));
  assert.ok(logged.includes('"kind":"gemini_limit"'));
  assert.ok(!logged.includes("個人メモ"), "the error message must not be logged");

  const d1 = context.describeOrganizeFailure("link_related", "obsidian", new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]"));
  assert.equal(d1.sqlite, "SQLITE_ERROR");
  assert.equal(d1.stage, "link_related");
});

test("failure log names parse problems without quoting model output", () => {
  assert.equal(context.describeOrganizeFailure("parse_result", "telegram", new Error("AI response did not contain JSON")).reason, "no_json");
  assert.equal(context.describeOrganizeFailure("gemini_call", "telegram", new Error("Gemini returned no text")).reason, "empty_response");
  const invalid = context.describeOrganizeFailure("parse_result", "telegram", new SyntaxError("Unexpected token 秘密 in JSON"));
  assert.equal(invalid.reason, "invalid_json");
  assert.ok(!JSON.stringify(invalid).includes("秘密"));
});

test("related-note search skips terms that exceed D1's LIKE pattern limit", async () => {
  const bound = [];
  const tooLong = "あ".repeat(20); // 60 bytes plus the surrounding % exceeds 50
  const fits = "あ".repeat(10); // 30 bytes plus the surrounding %
  const result = await context.linkRelatedNotes(fakeEnv(bound), { id: "tg:1:1" }, [tooLong, fits, "short"]);
  assert.deepEqual([...result], []);
  const patterns = bound.filter((value) => typeof value === "string" && value.startsWith("%"));
  assert.ok(patterns.length > 0, "usable terms must still be searched");
  for (const pattern of patterns) assert.ok(new TextEncoder().encode(pattern).length <= 50, `pattern too long: ${pattern}`);
  assert.ok(!patterns.includes(`%${tooLong}%`));
  assert.ok(patterns.includes(`%${fits}%`));
});

test("a term filtered out for length does not use up one of the four search slots", async () => {
  const bound = [];
  const tooLong = "あ".repeat(20);
  await context.linkRelatedNotes(fakeEnv(bound), { id: "tg:1:1" }, [tooLong, tooLong, "aa", "bb", "cc", "dd"]);
  const patterns = new Set(bound.filter((value) => typeof value === "string" && value.startsWith("%")));
  assert.deepEqual([...patterns].sort(), ["%aa%", "%bb%", "%cc%", "%dd%"]);
});
