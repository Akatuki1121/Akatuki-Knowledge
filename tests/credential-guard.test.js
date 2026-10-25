import test from "node:test";
import assert from "node:assert/strict";
import { inspectAndRedact } from "../src/ai-send-guard.mjs";

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

