import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasSensitiveCategory, inspectAndRedact, inspectWholeContent } from "../src/ai-send-guard.mjs";
import { parseGroundedWebResearch } from "../src/agent-web-research.mjs";
import { createGeminiClient } from "../src/gemini-client.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する
// (tests/organize-failure.test.js の「Worker ソースに存在する必要がある」の意図を引き継ぐ)。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./gemini-client.mjs"'), "the Worker entry point must import the Gemini client module");
assert.ok(workerSource.includes("createGeminiClient({"), "the Worker entry point must build the Gemini client through the factory");

const client = createGeminiClient({ inspectWholeContent, inspectAndRedact, hasSensitiveCategory, parseGroundedWebResearch });

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function geminiOk(text = "answer") {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}

test("model selection follows the output-token cap and env overrides", async () => {
  const stub = stubFetch(async () => geminiOk());
  try {
    await client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 500);
    assert.ok(stub.calls[0].url.includes("/models/gemini-3.1-flash-lite:generateContent"), "cap 500 uses the light model");
    await client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 501);
    assert.ok(stub.calls[1].url.includes("/models/gemini-3.5-flash-lite:generateContent"), "cap above 500 uses the standard model");
    await client.callGemini({ GEMINI_API_KEY: "k", GEMINI_LIGHT_MODEL: "light-x", GEMINI_MODEL: "std-x" }, "質問", 100);
    assert.ok(stub.calls[2].url.includes("/models/light-x:generateContent"), "GEMINI_LIGHT_MODEL overrides the light model");
    await client.callGemini({ GEMINI_API_KEY: "k", GEMINI_LIGHT_MODEL: "light-x", GEMINI_MODEL: "std-x" }, "質問", 900);
    assert.ok(stub.calls[3].url.includes("/models/std-x:generateContent"), "GEMINI_MODEL overrides the standard model");
  } finally {
    stub.restore();
  }
});

test("request body carries temperature, token cap and optional response MIME type", async () => {
  const stub = stubFetch(async () => geminiOk("text"));
  try {
    assert.equal(await client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 300), "text");
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.generationConfig.temperature, 0.2);
    assert.equal(body.generationConfig.maxOutputTokens, 300);
    assert.equal(body.generationConfig.responseMimeType, undefined);
    assert.equal(stub.calls[0].init.headers["x-goog-api-key"], "k");
    await client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 300, { responseMimeType: "application/json" });
    const body2 = JSON.parse(stub.calls[1].init.body);
    assert.equal(body2.generationConfig.responseMimeType, "application/json");
  } finally {
    stub.restore();
  }
});

test("API failure keeps status fields and never the upstream message (Issue #63)", async () => {
  const stub = stubFetch(async () => ({ ok: false, status: 429, json: async () => ({ error: { status: "RESOURCE_EXHAUSTED", message: "upstream free text 秘密" } }) }));
  try {
    const error = await client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 300).then(() => null, (e) => e);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Gemini API returned 429");
    assert.equal(error.httpStatus, 429);
    assert.equal(error.apiStatus, "RESOURCE_EXHAUSTED");
    assert.ok(!error.message.includes("秘密"));
  } finally {
    stub.restore();
  }
});

test("empty candidate text is an error", async () => {
  const stub = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) }));
  try {
    await assert.rejects(client.callGemini({ GEMINI_API_KEY: "k" }, "質問", 300), /Gemini returned no text/);
  } finally {
    stub.restore();
  }
});

test("web research stays gated off unless explicitly enabled", async () => {
  const stub = stubFetch(async () => geminiOk());
  try {
    await assert.rejects(client.callGeminiWebResearch({ GEMINI_API_KEY: "k" }, "質問"), /web_research_not_enabled/);
    assert.equal(stub.calls.length, 0, "disabled web research must not fetch");
  } finally {
    stub.restore();
  }
});

test("web research maps provider failures to stable error codes", async () => {
  const env = { GEMINI_API_KEY: "k", GEMINI_WEB_RESEARCH_ENABLED: "true" };
  const stub429 = stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  try {
    await assert.rejects(client.callGeminiWebResearch(env, "Cloudflare Workers の料金は"), /rate_limited/);
  } finally {
    stub429.restore();
  }
  const stub503 = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    await assert.rejects(client.callGeminiWebResearch(env, "Cloudflare Workers の料金は"), /upstream_5xx/);
  } finally {
    stub503.restore();
  }
});
