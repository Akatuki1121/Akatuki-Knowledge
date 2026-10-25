// Issue #86: src/telegram-client.mjs のモジュール契約テスト。
// Telegram 送信・編集 (sendTelegramMessage / editTelegramMessage) を
// index.js から分離したため、文字列抽出ではなくモジュールの振る舞いで検証する。
// fetch は呼び出し時点でグローバルを参照する前提を保ち、テストでは
// tests/gemini-client.test.js と同じ方式で globalThis.fetch を差し替える。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTelegramClient } from "../src/telegram-client.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./telegram-client.mjs"'), "the Worker entry point must import the Telegram client module");
assert.ok(workerSource.includes("createTelegramClient()"), "the Worker entry point must build the Telegram client through the factory");

const { sendTelegramMessage, editTelegramMessage } = createTelegramClient();
const env = { TELEGRAM_BOT_TOKEN: "test-token" };

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function telegramOk(result = {}) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}

test("sendTelegramMessage: トークン未設定時は fetch を呼ばずに固定のエラーを投げる", async () => {
  const stub = stubFetch(async () => telegramOk());
  try {
    await assert.rejects(sendTelegramMessage({}, 123, "本文"), { message: "TELEGRAM_BOT_TOKEN is not configured" });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("editTelegramMessage: トークン未設定時は fetch を呼ばずに固定のエラーを投げる", async () => {
  const stub = stubFetch(async () => telegramOk());
  try {
    await assert.rejects(editTelegramMessage({}, 123, 456, "本文"), { message: "TELEGRAM_BOT_TOKEN is not configured" });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("sendTelegramMessage: sendMessage へ本文を切り詰めずに送り、message_id を返す", async () => {
  const text = "あ".repeat(4001);
  const stub = stubFetch(async () => telegramOk({ message_id: 456 }));
  try {
    assert.equal(await sendTelegramMessage(env, 123, text), 456);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://api.telegram.org/bottest-token/sendMessage");
    assert.equal(stub.calls[0].init.method, "POST");
    assert.deepEqual(stub.calls[0].init.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { chat_id: 123, text });
  } finally {
    stub.restore();
  }
});

test("sendTelegramMessage: message_id がない応答では null を返す", async () => {
  const stub = stubFetch(async () => telegramOk({}));
  try {
    assert.equal(await sendTelegramMessage(env, 123, "本文"), null);
  } finally {
    stub.restore();
  }
});

test("sendTelegramMessage: JSON でない成功応答でも null を返す", async () => {
  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error("not json"); }
  }));
  try {
    assert.equal(await sendTelegramMessage(env, 123, "本文"), null);
  } finally {
    stub.restore();
  }
});

test("editTelegramMessage: editMessageText へ送り、本文を3500文字に切る", async () => {
  const text = "い".repeat(4000);
  const stub = stubFetch(async () => telegramOk({ message_id: 456 }));
  try {
    assert.equal(await editTelegramMessage(env, 123, 456, text), undefined);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://api.telegram.org/bottest-token/editMessageText");
    assert.equal(stub.calls[0].init.method, "POST");
    assert.deepEqual(stub.calls[0].init.headers, { "content-type": "application/json" });
    const body = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(body, { chat_id: 123, message_id: 456, text: "い".repeat(3500) });
    assert.equal(body.text.length, 3500);
  } finally {
    stub.restore();
  }
});

test("sendTelegramMessage: HTTP 失敗時はステータスだけのエラーを投げ、トークンを含めない", async () => {
  const stub = stubFetch(async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false, description: "test-token must not leak" })
  }));
  try {
    const error = await sendTelegramMessage(env, 123, "本文").then(() => null, (caught) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Telegram sendMessage returned 502");
    assert.ok(!error.message.includes("test-token"));
  } finally {
    stub.restore();
  }
});

test("editTelegramMessage: HTTP が成功でも data.ok が false なら失敗として扱う", async () => {
  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, description: "test-token must not leak" })
  }));
  try {
    const error = await editTelegramMessage(env, 123, 456, "本文").then(() => null, (caught) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Telegram editMessageText returned 200");
    assert.ok(!error.message.includes("test-token"));
  } finally {
    stub.restore();
  }
});
