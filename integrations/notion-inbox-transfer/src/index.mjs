const NOTION_VERSION = "2026-03-11";
const MAX_MARKDOWN_CHARS = 500000;
const UNSUPPORTED_NOTION_BLOCK = /<(?:callout|toggle|columns?|database|page|folder|synced-block(?:-reference)?|pdf|image|embed|file|audio|video|bookmark|meeting-notes|external_object_instance|custom-block|link-preview|mention|date|quote|todo|equation|table|h[1-4]|ul|ol|li|unknown)\b/i;

class TransferError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "TransferError";
    this.code = code;
    this.status = status;
  }
}

function safePath(value) {
  if (typeof value !== "string") return false;
  const path = value.trim();
  return path.length > 0 && path.length <= 1000 && !path.startsWith("/")
    && /\.md$/i.test(path)
    && !path.split("/").some((part) => !part || part === ".." || part.startsWith("."));
}

function richText(property) {
  const items = property?.rich_text ?? property?.title;
  return Array.isArray(items)
    ? items.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("").trim()
    : "";
}

function pageStatus(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property) return "未処理";
  if (property.type === "status") return property.status?.name ?? "未処理";
  if (property.type === "select") return property.select?.name ?? "未処理";
  return "invalid";
}

function validateMarkdown(result) {
  if (typeof result?.markdown !== "string" || !result.markdown.trim()) throw new TransferError("notion_markdown_empty");
  if (result.truncated === true) throw new TransferError("notion_markdown_truncated");
  if (Array.isArray(result.unknown_block_ids) && result.unknown_block_ids.length) throw new TransferError("notion_markdown_unknown_blocks");
  if (result.markdown.length > MAX_MARKDOWN_CHARS) throw new TransferError("note_too_large");
  if (/notion-file-block:\/\//i.test(result.markdown)) throw new TransferError("notion_uploaded_media_not_portable");
  if (UNSUPPORTED_NOTION_BLOCK.test(result.markdown)) throw new TransferError("notion_rich_block_requires_conversion");
  return result.markdown;
}

async function requestJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, options); }
  catch { throw new TransferError("upstream_network_error"); }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    throw new TransferError(typeof body?.code === "string" ? body.code : "upstream_http_error", response.status);
  }
  return body;
}

function headers(token, json = false) {
  return {
    authorization: "Bearer " + token,
    ...(json ? { "content-type": "application/json" } : {})
  };
}

async function notion(env, fetchImpl, path, options = {}) {
  return requestJson(fetchImpl, "https://api.notion.com/v1" + path, {
    ...options,
    headers: { ...headers(env.NOTION_TOKEN, options.method === "POST" || options.method === "PATCH"), "Notion-Version": NOTION_VERSION }
  });
}

async function akatuki(env, fetchImpl, path, options = {}) {
  return requestJson(fetchImpl, env.AKATUKI_API_URL.replace(/\/+$/, "") + path, {
    ...options,
    headers: headers(env.AKATUKI_API_TOKEN, options.method === "POST" || options.method === "PATCH")
  });
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function queryInbox(env, fetchImpl) {
  const pages = [];
  let startCursor = null;
  // Scan up to 1,000 rows per Cron invocation so review-only rows cannot
  // permanently hide pending rows farther down a large database.
  for (let page = 0; page < 10; page++) {
    const statusProperty = env.NOTION_STATUS_PROPERTY || "処理状態";
    const body = {
      page_size: 100,
      filter: {
        or: [
          { property: statusProperty, select: { equals: "未処理" } },
          { property: statusProperty, select: { equals: "処理中" } }
        ]
      }
    };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notion(env, fetchImpl, "/data_sources/" + encodeURIComponent(env.NOTION_DATA_SOURCE_ID) + "/query", {
      method: "POST", body: JSON.stringify(body)
    });
    if (!Array.isArray(result.results)) throw new TransferError("notion_query_invalid_response");
    pages.push(...result.results);
    if (result.has_more !== true) return pages;
    if (typeof result.next_cursor !== "string" || !result.next_cursor) {
      throw new TransferError("notion_query_cursor_missing");
    }
    startCursor = result.next_cursor;
  }
  return pages;
}

async function readMarkdown(env, fetchImpl, pageId) {
  return validateMarkdown(await notion(env, fetchImpl, "/pages/" + encodeURIComponent(pageId) + "/markdown?markdown_version=v2"));
}

async function getNote(env, fetchImpl, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  try {
    const result = await akatuki(env, fetchImpl, "/api/notes/" + encodedPath);
    return result.note ?? result;
  } catch (error) {
    if (error instanceof TransferError && error.status === 404) return null;
    throw error;
  }
}

async function searchHit(env, fetchImpl, path) {
  const basename = path.split("/").pop().replace(/\.md$/i, "");
  const q = basename.length >= 2 ? basename : path;
  const result = await akatuki(env, fetchImpl, "/api/search?" + new URLSearchParams({ q }));
  return Array.isArray(result.results) && result.results.some((item) => item?.source === "obsidian" && item?.path === path);
}

async function outboxHit(env, fetchImpl, path) {
  let before = null;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (before !== null) params.set("before", String(before));
    const result = await akatuki(env, fetchImpl, "/sync/outbox?" + params);
    if (result.ok !== true || !Array.isArray(result.jobs)) throw new TransferError("akatuki_outbox_unavailable");
    if (result.jobs.some((job) => job?.entity_type === "notes" && job?.entity_id === path
      && job?.operation === "upsert" && ["pending", "processing", "sent"].includes(job?.status))) return true;
    if (result.nextBefore == null) return false;
    before = result.nextBefore;
  }
  return false;
}

async function verifyLanding(env, fetchImpl, path, expectedHash, sourceTag) {
  const note = await getNote(env, fetchImpl, path);
  return Boolean(note && note.path === path && note.contentHash === expectedHash
    && Array.isArray(note.tags) && note.tags.includes(sourceTag)
    && await searchHit(env, fetchImpl, path)
    && await outboxHit(env, fetchImpl, path));
}

async function updateStatus(env, fetchImpl, pageId, status) {
  const name = env.NOTION_STATUS_PROPERTY || "処理状態";
  await notion(env, fetchImpl, "/pages/" + encodeURIComponent(pageId), {
    method: "PATCH", body: JSON.stringify({ properties: { [name]: { select: { name: status } } } })
  });
}

async function trashPage(env, fetchImpl, pageId) {
  const result = await notion(env, fetchImpl, "/pages/" + encodeURIComponent(pageId), {
    method: "PATCH", body: JSON.stringify({ in_trash: true })
  });
  if (result.in_trash !== true) throw new TransferError("notion_trash_not_confirmed");
}

async function processPage(env, fetchImpl, page, logger) {
  const pageId = page?.id;
  if (typeof pageId !== "string" || !pageId) return { outcome: "skipped", reason: "invalid_page_id" };

  const pathName = env.NOTION_PATH_PROPERTY || "Path";
  const titleName = env.NOTION_TITLE_PROPERTY || "Name";
  const statusName = env.NOTION_STATUS_PROPERTY || "処理状態";
  const path = richText(page.properties?.[pathName]);
  if (!safePath(path)) {
    await updateStatus(env, fetchImpl, pageId, "要確認");
    return { outcome: "review", reason: "invalid_destination_path", pageId };
  }

  const status = pageStatus(page, statusName);
  if (status === "要確認") return { outcome: "skipped", reason: "already_marked_for_review", pageId, path };
  if (!["未処理", "処理中"].includes(status)) {
    return { outcome: "review", reason: "invalid_status_property", pageId, path };
  }

  let markdown;
  try {
    markdown = await readMarkdown(env, fetchImpl, pageId);
  } catch (error) {
    if (["notion_markdown_empty", "notion_markdown_truncated", "notion_markdown_unknown_blocks",
      "note_too_large", "notion_uploaded_media_not_portable", "notion_rich_block_requires_conversion"].includes(error.code)) {
      await updateStatus(env, fetchImpl, pageId, "要確認");
      return { outcome: "review", reason: error.code, pageId, path };
    }
    throw error;
  }
  const expectedHash = await sha256Hex(markdown);
  if (status !== "処理中") {
    const existing = await getNote(env, fetchImpl, path);
    if (existing) {
      await updateStatus(env, fetchImpl, pageId, "要確認");
      return { outcome: "review", reason: "destination_path_already_exists", pageId, path };
    }
    await updateStatus(env, fetchImpl, pageId, "処理中");
  }

  const sourceTag = "notion-page:" + pageId;
  let note = await getNote(env, fetchImpl, path);
  if (note && (!Array.isArray(note.tags) || !note.tags.includes(sourceTag))) {
    await updateStatus(env, fetchImpl, pageId, "要確認");
    return { outcome: "review", reason: "destination_not_created_by_this_inbox_item", pageId, path };
  }
  if (!note) {
    const title = richText(page.properties?.[titleName]) || path.split("/").pop().replace(/\.md$/i, "");
    try {
      await akatuki(env, fetchImpl, "/api/notes", {
        method: "POST", body: JSON.stringify({ path, title, content: markdown, tags: ["notion-inbox", sourceTag] })
      });
    } catch (error) {
      if (error instanceof TransferError && error.status === 409) {
        await updateStatus(env, fetchImpl, pageId, "要確認");
        return { outcome: "review", reason: "destination_path_already_exists", pageId, path };
      }
      if (error instanceof TransferError && [400, 413, 422].includes(error.status)) {
        await updateStatus(env, fetchImpl, pageId, "要確認");
      }
      throw error;
    }
    note = await getNote(env, fetchImpl, path);
  }

  if (!note || note.path !== path || note.contentHash !== expectedHash
    || !Array.isArray(note.tags) || !note.tags.includes(sourceTag)) {
    await updateStatus(env, fetchImpl, pageId, "要確認");
    return { outcome: "review", reason: "destination_content_mismatch", pageId, path };
  }
  if (!await verifyLanding(env, fetchImpl, path, expectedHash, sourceTag)) {
    return { outcome: "pending_verification", reason: "landing_not_confirmed", pageId, path };
  }

  await trashPage(env, fetchImpl, pageId);
  logger.info("notion_note_transferred", { pageId, path });
  return { outcome: "transferred", pageId, path };
}

export async function runInboxTransfer(env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  if (!env?.NOTION_TOKEN || !env?.NOTION_DATA_SOURCE_ID || !env?.AKATUKI_API_TOKEN || !env?.AKATUKI_API_URL) {
    logger.error("notion_transfer_configuration_missing");
    return { ok: false, processed: 0, error: "configuration_missing" };
  }
  let pages;
  try { pages = await queryInbox(env, fetchImpl); }
  catch (error) {
    logger.error("notion_transfer_query_failed", { code: error.code ?? "unknown", status: error.status ?? null });
    return { ok: false, processed: 0, error: error.code ?? "query_failed" };
  }
  const statusName = env.NOTION_STATUS_PROPERTY || "処理状態";
  const page = pages.find((item) => ["未処理", "処理中"].includes(pageStatus(item, statusName)));
  if (!page) return { ok: true, processed: 0, outcome: "inbox_empty" };
  try {
    const result = await processPage(env, fetchImpl, page, logger);
    logger.info("notion_transfer_result", { outcome: result.outcome, reason: result.reason ?? null, pageId: result.pageId ?? null, path: result.path ?? null });
    return { ok: result.outcome !== "review", processed: 1, ...result };
  } catch (error) {
    logger.error("notion_transfer_failed", { code: error.code ?? "transfer_failed", status: error.status ?? null, pageId: page.id });
    return { ok: false, processed: 1, error: error.code ?? "transfer_failed", pageId: page.id };
  }
}

export default {
  async scheduled(_controller, env, ctx) { ctx.waitUntil(runInboxTransfer(env)); },
  async fetch(request) {
    if (new URL(request.url).pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "akatuki-notion-inbox-transfer" });
    }
    return new Response("Not found", { status: 404 });
  }
};
