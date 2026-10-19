import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const rulesMatch = source.match(/var CREDENTIAL_RULES = \[([\s\S]*?)\n\];/);
assert.ok(rulesMatch, "CREDENTIAL_RULES must exist in the Worker source");
const rules = vm.runInNewContext("[" + rulesMatch[1] + "]");

function detectsCredential(value) {
  return rules.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

test("blocks common credential assignment formats", () => {
  for (const value of [
    "password=abc",
    'password: "phrase with spaces"',
    "Passphrase='long phrase here'",
    "API_KEY=abc123",
    '"token": "abc123"',
    "authorization: Bearer abcdefghijklmnop",
    "cookie=sessionid",
    "credential:abc",
  ]) {
    assert.equal(detectsCredential(value), true, "should detect " + value);
  }
});

test("detects Japanese credential labels even after Japanese text", () => {
  for (const value of [
    "パスワード=abc",
    "設定: パスワード=abc",
    "秘密鍵: abc",
    "認証トークン=abc",
  ]) {
    assert.equal(detectsCredential(value), true, "should detect " + value);
  }
});

test("detects common token formats and private key blocks", () => {
  assert.equal(detectsCredential("Bearer abcdefghijklmnop"), true);
  assert.equal(detectsCredential("ghp_123456789012345678901234"), true);
  assert.equal(
    detectsCredential("-----BEGIN PRIVATE KEY-----\\n012345678901234567890123456789\\n-----END PRIVATE KEY-----"),
    true,
  );
});

test("does not flag ordinary prose without a credential assignment", () => {
  for (const value of [
    "I changed my password yesterday.",
    "The token system is documented below.",
    "パスワードの管理方法について説明します。",
    "This note contains no credentials.",
  ]) {
    assert.equal(detectsCredential(value), false, "should not detect " + value);
  }
});

test("the shared Gemini boundary checks the assembled prompt before fetch", () => {
  const start = source.indexOf("async function callGemini(env, prompt, maxOutputTokens)");
  assert.notEqual(start, -1, "callGemini must exist");
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, "callGemini function body must be found");
  const body = source.slice(start, end);
  assert.ok(body.includes("inspectWholeContent(prompt, env)"));
  assert.ok(body.includes("if (!privacyCheck.ok)"));
  assert.ok(body.indexOf("inspectWholeContent(prompt, env)") < body.indexOf("await fetch(endpoint"));
  assert.ok(body.includes('throw new Error("AI request blocked by credential detection")'));
});
