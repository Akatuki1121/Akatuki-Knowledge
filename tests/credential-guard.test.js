import test from "node:test";
import assert from "node:assert/strict";
import { hasSensitiveCategory, inspectAndRedact, inspectWholeContent } from "../src/ai-send-guard.mjs";
import { parseGroundedWebResearch } from "../src/agent-web-research.mjs";
import { createGeminiClient } from "../src/gemini-client.mjs";

function detectsCredential(value) {
  return inspectAndRedact(value).findings.includes("credentials");
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
  ]) assert.equal(detectsCredential(value), true, "should detect " + value);
});

test("detects Japanese credential labels", () => {
  for (const value of ["パスワード=abc", "設定: パスワード=abc", "秘密鍵: abc", "認証トークン=abc"])
    assert.equal(detectsCredential(value), true, "should detect " + value);
});

test("detects token formats and private key blocks", () => {
  assert.equal(detectsCredential("Bearer abcdefghijklmnop"), true);
  assert.equal(detectsCredential("ghp_123456789012345678901234"), true);
  assert.equal(detectsCredential("-----BEGIN PRIVATE KEY-----\\n012345678901234567890123456789\\n-----END PRIVATE KEY-----"), true);
});

test("does not flag ordinary prose without credential assignment", () => {
  for (const value of ["I changed my password yesterday.", "The token system is documented below.", "パスワードの管理方法について説明します。", "This note contains no credentials."])
    assert.equal(detectsCredential(value), false, "should not detect " + value);
});

test("shared Gemini boundary checks assembled prompt before fetch", async () => {
  // #86 で src/gemini-client.mjs へ分離したため、文字列抽出ではなくモジュールの振る舞いで検証する。
  // 2026-10-25 の方針変更後は、fetch 前に止めるのは認証情報だけ。
  // 機微語 (診断など) を含むプロンプトは通常の質問と同様に fetch へ進む。
  const { callGemini } = createGeminiClient({ inspectWholeContent, inspectAndRedact, hasSensitiveCategory, parseGroundedWebResearch });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
  };
  try {
    await assert.rejects(callGemini({}, "password=abc123", 100), /AI request blocked by credential detection/);
    assert.equal(fetchCalls, 0, "credential prompts must be blocked before fetch");
    assert.equal(await callGemini({}, "今日の診断結果をまとめて", 100), "ok");
    assert.equal(fetchCalls, 1, "sensitive-word prompts are no longer blocked (policy change 2026-10-25)");
    assert.equal(await callGemini({}, "通常の質問です", 100), "ok");
    assert.equal(fetchCalls, 2, "clean prompts reach fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
