import assert from "node:assert/strict";
import { runInboxTransfer } from "../integrations/notion-inbox-transfer/src/index.mjs";

const pageId = "11111111-1111-4111-8111-111111111111";
const path = "Notes/Inbox/transfer-test.md";
const markdown = "# Transfer test\n\nBody text.\n";
const env = {
  NOTION_TOKEN: "test-notion-token",
  NOTION_DATA_SOURCE_ID: "22222222-2222-4222-8222-222222222222",
  AKATUKI_API_TOKEN: "test-akatuki-token",
  AKATUKI_API_URL: "https://akatuki.example",
  NOTION_PATH_PROPERTY: "Path",
  NOTION_TITLE_PROPERTY: "Name",
  NOTION_STATUS_PROPERTY: "処理状態"
};

function page(status = "未処理") {
  return {
    id: pageId,
    properties: {
      Name: { type: "title", title: [{ plain_text: "Transfer test" }] },
      Path: { type: "rich_text", rich_text: [{ plain_text: path }] },
      "処理状態": { type: "select", select: { name: status } }
    }
  };
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function harness({ duplicate = false, failCreate = false } = {}) {
  const state = { status: "未処理", trashed: false, created: false, calls: [], logs: [] };
  const logger = {
    info: (...args) => state.logs.push(["info", ...args]),
    error: (...args) => state.logs.push(["error", ...args])
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push({ url: url.toString(), method, body });

    if (url.hostname === "api.notion.com" && url.pathname.endsWith("/data_sources/" + env.NOTION_DATA_SOURCE_ID + "/query")) {
      return Response.json({ results: [page(state.status)] });
    }
    if (url.hostname === "api.notion.com" && url.pathname.endsWith("/pages/" + pageId + "/markdown")) {
      return Response.json({ markdown, truncated: false, unknown_block_ids: [] });
    }
    if (url.hostname === "api.notion.com" && url.pathname === "/v1/pages/" + pageId && method === "PATCH") {
      if (body.properties) state.status = body.properties["処理状態"].select.name;
      if (body.in_trash === true) state.trashed = true;
      return Response.json({ id: pageId, in_trash: state.trashed });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/api/notes/" + path.split("/").map(encodeURIComponent).join("/")) {
      if (duplicate || state.created) return Response.json({ note: { path, contentHash: await digest(markdown) } });
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/api/notes" && method === "POST") {
      if (failCreate) return Response.json({ error: "test_failure" }, { status: 503 });
      state.created = true;
      return Response.json({ ok: true, path, queued: true }, { status: 201 });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/api/search") {
      return Response.json({ results: state.created ? [{ source: "obsidian", path }] : [] });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/sync/outbox") {
      return Response.json({ ok: true, jobs: state.created ? [{ entity_type: "notes", entity_id: path, operation: "upsert", status: "pending" }] : [], nextBefore: null });
    }
    throw new Error("Unexpected test request: " + method + " " + url);
  };
  return { state, logger, fetchImpl };
}

// 正常系: 検索と outbox の着地確認が終わるまで Notion をゴミ箱へ移さない。
{
  const h = harness();
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "transferred");
  assert.equal(h.state.created, true);
  assert.equal(h.state.trashed, true);
  const trashIndex = h.state.calls.findIndex((call) => call.url.endsWith("/v1/pages/" + pageId) && call.body.in_trash === true);
  const searchIndex = h.state.calls.findIndex((call) => call.url.includes("/api/search?"));
  const outboxIndex = h.state.calls.findIndex((call) => call.url.includes("/sync/outbox?"));
  assert.ok(trashIndex > searchIndex && trashIndex > outboxIndex);
}

// 異常系: 作成失敗時は原本を残し、処理中状態で次回の再試行・回復に備える。
{
  const h = harness({ failCreate: true });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.ok, false);
  assert.equal(h.state.trashed, false);
  assert.equal(h.state.status, "処理中");
}

// 重複系: 同じパスがあれば作成せず、Notion 原本を残して要確認にする。
{
  const h = harness({ duplicate: true });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "review");
  assert.equal(h.state.created, false);
  assert.equal(h.state.trashed, false);
  assert.equal(h.state.status, "要確認");
  assert.equal(h.state.calls.some((call) => call.url.endsWith("/api/notes") && call.method === "POST"), false);
}

console.log("Notion inbox transfer tests passed.");
