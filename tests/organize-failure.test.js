import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  D1_LIKE_PATTERN_MAX_BYTES,
  describeOrganizeFailure,
  linkRelatedNotes
} from "../src/organize.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する
// (旧テストの「Worker ソースに存在する必要がある」の意図を引き継ぐ)。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./organize.mjs"'), "the Worker entry point must import the organize module");

assert.ok(
  Number.isInteger(D1_LIKE_PATTERN_MAX_BYTES) && D1_LIKE_PATTERN_MAX_BYTES > 0,
  "D1_LIKE_PATTERN_MAX_BYTES must exist"
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
  const logged = JSON.stringify(describeOrganizeFailure("gemini_call", "telegram", error));
  assert.ok(logged.includes('"stage":"gemini_call"'));
  assert.ok(logged.includes('"httpStatus":429'));
  assert.ok(logged.includes('"apiStatus":"RESOURCE_EXHAUSTED"'));
  assert.ok(logged.includes('"kind":"gemini_limit"'));
  assert.ok(!logged.includes("個人メモ"), "the error message must not be logged");

  const d1 = describeOrganizeFailure("link_related", "obsidian", new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]"));
  assert.equal(d1.sqlite, "SQLITE_ERROR");
  assert.equal(d1.stage, "link_related");
});

test("failure log names parse problems without quoting model output", () => {
  assert.equal(describeOrganizeFailure("parse_result", "telegram", new Error("AI response did not contain JSON")).reason, "no_json");
  assert.equal(describeOrganizeFailure("gemini_call", "telegram", new Error("Gemini returned no text")).reason, "empty_response");
  const invalid = describeOrganizeFailure("parse_result", "telegram", new SyntaxError("Unexpected token 秘密 in JSON"));
  assert.equal(invalid.reason, "invalid_json");
  assert.ok(!JSON.stringify(invalid).includes("秘密"));
});

test("related-note search skips terms that exceed D1's LIKE pattern limit", async () => {
  const bound = [];
  const tooLong = "あ".repeat(20); // 60 bytes plus the surrounding % exceeds 50
  const fits = "あ".repeat(10); // 30 bytes plus the surrounding %
  const result = await linkRelatedNotes(fakeEnv(bound), { id: "tg:1:1" }, [tooLong, fits, "short"]);
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
  await linkRelatedNotes(fakeEnv(bound), { id: "tg:1:1" }, [tooLong, tooLong, "aa", "bb", "cc", "dd"]);
  const patterns = new Set(bound.filter((value) => typeof value === "string" && value.startsWith("%")));
  assert.deepEqual([...patterns].sort(), ["%aa%", "%bb%", "%cc%", "%dd%"]);
});
