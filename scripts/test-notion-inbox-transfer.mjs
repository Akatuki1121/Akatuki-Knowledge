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

function harness({ duplicate = false, failCreate = false, sourceMarkdown = markdown, truncated = false, unknownBlockIds = [] } = {}) {
  const state = { status: "未処理", trashed: false, created: false, tags: [], content: "", calls: [], logs: [] };
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
      return Response.json({ markdown: sourceMarkdown, truncated, unknown_block_ids: unknownBlockIds });
    }
    if (url.hostname === "api.notion.com" && url.pathname === "/v1/pages/" + pageId && method === "PATCH") {
      if (body.properties) state.status = body.properties["処理状態"].select.name;
      if (body.in_trash === true) state.trashed = true;
      return Response.json({ id: pageId, in_trash: state.trashed });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/api/notes/" + path.split("/").map(encodeURIComponent).join("/")) {
      if (duplicate || state.created) return Response.json({ note: { path, contentHash: await digest(state.content || markdown), tags: duplicate ? [] : state.tags } });
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.hostname === "akatuki.example" && url.pathname === "/api/notes" && method === "POST") {
      if (failCreate) return Response.json({ error: "test_failure" }, { status: 503 });
      state.created = true;
      state.content = body.content;
      state.tags = body.tags;
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


// Notion-flavored Markdown v2: tag fixtures are converted before destination hash verification.
{
  const fixtures = [
    ["heading h1", "<h1>章タイトル</h1>", "# 章タイトル"],
    ["heading h2", "<h2>章タイトル</h2>", "## 章タイトル"],
    ["heading h3", "<h3>章タイトル</h3>", "### 章タイトル"],
    ["heading h4", "<h4>章タイトル</h4>", "#### 章タイトル"],
    ["quote", "<quote>引用文</quote>", "> 引用文"],
    ["todo unchecked", '<todo checked="false">確認する</todo>', "- [ ] 確認する"],
    ["todo checked", '<todo checked="true">確認済み</todo>', "- [x] 確認済み"],
    ["unordered list", "<ul>\n<li>一つ目</li>\n<li>二つ目</li>\n</ul>", "- 一つ目\n- 二つ目"],
    ["ordered list", "<ol>\n<li>一番目</li>\n<li>二番目</li>\n</ol>", "1. 一番目\n2. 二番目"],
    ["table", "<table><tr><th>項目</th><th>値</th></tr><tr><td>色</td><td>青</td></tr></table>", "| 項目 | 値 |\n| --- | --- |\n| 色 | 青 |"],
    ["callout", '<callout icon="💡">補足内容</callout>', "補足内容"],
    ["toggle", "<toggle>折りたたみ見出し\n\n詳細</toggle>", "折りたたみ見出し\n\n詳細"],
    ["columns", "<columns><column>左側</column><column>右側</column></columns>", "左側\n\n右側"],
    ["synced block", '<synced-block url="https://notion.so/block">共有内容</synced-block>', "共有内容"],
    ["synced block reference", '<synced-block-reference url="https://notion.so/block">参照内容</synced-block-reference>', "参照内容"],
    ["table text fallback", "<table>表の構造を復元できない内容</table>", "表の構造を復元できない内容"],
    ["mention", '<mention url="https://notion.so/page">参照ページ</mention>', "参照ページ"],
    ["date", '<date start="2026-11-06" start-time="09:30" />', "2026-11-06 09:30"],
    ["equation", "<equation>x + y = z</equation>", "x + y = z"],
    ["color span", '<span color="blue">青い文字</span>', "青い文字"]
  ];
  for (const [name, sourceMarkdown, expected] of fixtures) {
    const h = harness({ sourceMarkdown });
    const result = await runInboxTransfer(env, h);
    assert.equal(result.outcome, "transferred", name);
    assert.equal(h.state.content.trim(), expected, name);
    assert.ok(h.state.logs.some(([level, event]) => level === "info" && event === "notion_markdown_converted"), name);
    assert.equal(h.state.trashed, true, name);
  }
}

// Media, unsupported/unknown blocks, and truncation stay in review without creating a note.
{
  for (const options of [
    { sourceMarkdown: '<pdf source="https://files.notion.so/example.pdf">資料</pdf>' },
    { sourceMarkdown: "![画像](https://files.notion.so/example.png)" },
    { sourceMarkdown: "添付参照: notion-file-block://file-id" },
    { sourceMarkdown: '<unknown url="https://notion.so/block" />' },
    { sourceMarkdown: "<tabs><tab>未対応</tab></tabs>" },
    { sourceMarkdown: "通常本文", truncated: true },
    { sourceMarkdown: "通常本文", unknownBlockIds: ["33333333-3333-4333-8333-333333333333"] }
  ]) {
    const h = harness(options);
    const result = await runInboxTransfer(env, h);
    assert.equal(result.outcome, "review");
    assert.equal(h.state.created, false);
    assert.equal(h.state.trashed, false);
    assert.equal(h.state.status, "要確認");
  }
}

// Fenced code examples remain literal and are not treated as live Notion tags.
{
  const fence = String.fromCharCode(96).repeat(3);
  const sourceMarkdown = "Example:\n\n" + fence + "xml\n<callout>literal</callout>\n" + fence;
  const h = harness({ sourceMarkdown });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "transferred");
  assert.equal(h.state.content, sourceMarkdown);
}

// A tag not supported by the converter must stop the transfer.
{
  const h = harness({ sourceMarkdown: '<mail to="team@example.com">未変換</mail>' });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "review");
  assert.equal(h.state.created, false);
  assert.equal(h.state.trashed, false);
  assert.equal(h.state.status, "要確認");
}


{
  const sourceMarkdown = "Literal escaped tag: \\<callout>text</callout>";
  const h = harness({ sourceMarkdown });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "transferred");
  assert.equal(h.state.content, sourceMarkdown);
}
{
  const fence = String.fromCharCode(96).repeat(3);
  const sourceMarkdown = [fence + "markdown", "![literal](https://example.com/image.png)", fence].join("\n");
  const h = harness({ sourceMarkdown });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "transferred");
  assert.equal(h.state.content, sourceMarkdown);
}


// Inline code also contains literal tag examples and must not be parsed as Notion structure.
{
  const tick = String.fromCharCode(96);
  const sourceMarkdown = "Inline: " + tick + "<callout>literal</callout>" + tick;
  const h = harness({ sourceMarkdown });
  const result = await runInboxTransfer(env, h);
  assert.equal(result.outcome, "transferred");
  assert.equal(h.state.content, sourceMarkdown);
}

console.log("Notion inbox transfer tests passed.");
