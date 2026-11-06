const NOTION_VERSION = "2026-03-11";
const MAX_MARKDOWN_CHARS = 500000;
const UNSUPPORTED_NOTION_BLOCK = /<(?:callout|toggle|columns?|synced-block(?:-reference)?|mention|date|quote|todo|equation|table|h[1-4]|ul|ol|li|unknown|tabs?|mail)\b|<span\s+color=/i;
const UNSUPPORTED_NOTION_MEDIA = /<(?:pdf|image|embed|file|audio|video|bookmark|link-preview|external_object_instance|custom-block|database|page|folder|meeting-notes)\b|!\[[^\]]*\]\([^)]+\)|notion-file-block:\/\//i;

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

function parseTagAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(/([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseNotionMarkup(markdown) {
  const root = { tag: null, children: [] };
  const stack = [root];
  for (const token of markdown.matchAll(/(?<!\\)<\/?[a-z][\w:-]*\b[^>]*>|[^<]+|</gi)) {
    const raw = token[0];
    const match = raw.match(/^<(\/)?([a-z][\w:-]*)\b([^>]*)>$/i);
    if (!match) { stack.at(-1).children.push({ text: raw }); continue; }
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    if (closing) {
      let index = stack.length - 1;
      while (index > 0 && stack[index].tag !== tag) index--;
      if (index > 0) stack.length = index;
      else stack.at(-1).children.push({ text: raw });
      continue;
    }
    const selfClosing = /\/\s*>$/.test(raw);
    const node = { tag, attrs: parseTagAttributes(match[3]), rawOpen: raw, rawClose: "</" + tag + ">", selfClosing, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function plainNodeText(node) {
  if (node.text !== undefined) return node.text;
  return (node.children ?? []).map(plainNodeText).join("");
}

function renderNotionNode(node, context) {
  if (node.text !== undefined) return node.text;
  const tag = node.tag;
  const attrs = node.attrs ?? {};
  const children = node.children ?? [];
  const depth = context.depth ?? 0;
  const child = (nextDepth = depth) => children.map(item => renderNotionNode(item, { ...context, depth: nextDepth })).join("");
  const block = value => value.trim() ? "\n\n" + value.trim() + "\n\n" : "\n\n";
  const mark = reason => context.reasons.add(reason);

  if (/^h[1-4]$/.test(tag)) { mark("heading"); return block("#".repeat(Number(tag.slice(1))) + " " + child().trim()); }
  if (tag === "quote") { mark("quote"); return block(child().trim().split("\n").map(line => "> " + line).join("\n")); }
  if (tag === "todo") { mark("todo"); return "  ".repeat(depth) + "- [" + (attrs.checked === "true" ? "x" : " ") + "] " + child().trim() + "\n"; }
  if (tag === "ul" || tag === "ol") {
    mark("list");
    let index = 0;
    return children.map(item => {
      if (item.text !== undefined) return item.text;
      if (item.tag !== "li") return renderNotionNode(item, { ...context, depth: depth + 1 });
      index++;
      const marker = tag === "ol" ? index + ". " : "- ";
      return "  ".repeat(depth) + marker + item.children.map(part => renderNotionNode(part, { ...context, depth: depth + 1 })).join("").trim() + "\n";
    }).join("");
  }
  if (tag === "li") { mark("list"); return "  ".repeat(depth) + "- " + child(depth + 1).trim() + "\n"; }
  if (tag === "table") {
    mark("table");
    const rows = [];
    let valid = true;
    const collect = current => {
      for (const item of current.children ?? []) {
        if (item.text !== undefined) continue;
        if (item.tag === "tr") {
          const cells = (item.children ?? []).filter(cell => cell.tag === "th" || cell.tag === "td");
          if (!cells.length) { valid = false; return; }
          rows.push({ header: cells.some(cell => cell.tag === "th"), cells: cells.map(cell => cell.children.map(part => renderNotionNode(part, context)).join("").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()) });
        } else if (["thead","tbody","tfoot"].includes(item.tag)) collect(item);
        else if (!["colgroup","col"].includes(item.tag)) { valid = false; return; }
        if (!valid) return;
      }
    };
    collect(node);
    if (valid && rows.length) {
      const width = Math.max(...rows.map(row => row.cells.length));
      const lines = rows.map(row => "| " + Array.from({length:width},(_,i)=>row.cells[i] ?? "").join(" | ") + " |");
      const separator = "| " + Array.from({length:width},()=>"---").join(" | ") + " |";
      const headerIndex = rows.findIndex(row => row.header);
      lines.splice(headerIndex >= 0 ? headerIndex + 1 : 1, 0, separator);
      return block(lines.join("\n"));
    }
    return block(plainNodeText(node));
  }
  if (tag === "mention") { mark("mention"); return child().trim() || attrs.url || ""; }
  if (tag === "date") {
    mark("date");
    const start = attrs.start ?? "";
    const end = attrs.end ?? "";
    const st = attrs["start-time"] ?? "";
    const et = attrs["end-time"] ?? "";
    return start ? start + (st ? " " + st : "") + (end ? " – " + end + (et ? " " + et : "") : "") : end;
  }
  if (tag === "equation") { mark("equation"); return child(); }
  if (tag === "span" && Object.hasOwn(attrs,"color")) { mark("color_span"); return child(); }
  if (["callout","toggle","columns","column","synced-block","synced-block-reference"].includes(tag)) {
    mark(["columns","column"].includes(tag) ? "columns" : tag.startsWith("synced-block") ? "synced_block" : tag);
    return block(child().trim());
  }
  if (tag === "p") return node.selfClosing ? "\n\n" : block(child().trim());
  if (["tr","th","td","thead","tbody","tfoot","colgroup","col"].includes(tag)) return child();
  if (node.selfClosing) return node.rawOpen;
  return node.rawOpen + child() + node.rawClose;
}

function transformOutsideCode(markdown, transform) {
  const lines = markdown.match(/.*(?:\n|$)/g) ?? [markdown];
  const output = [];
  let fence = null;
  let plain = "";
  const tick = String.fromCharCode(96);
  const flush = () => { if (plain) output.push(transform(plain)); plain = ""; };
  for (const line of lines) {
    if (!line) continue;
    const trimmed = line.replace(/^ {0,3}/, "");
    const fenceChar = trimmed.startsWith(tick.repeat(3)) ? tick : trimmed.startsWith("~~~") ? "~" : null;
    if (!fence && fenceChar) {
      const count = trimmed.split("").filter(char => char === fenceChar).length;
      if (count >= 3 && trimmed.slice(0,count) === fenceChar.repeat(count)) {
        flush(); fence = { char: fenceChar, length: count }; output.push(line); continue;
      }
    }
    if (fence) {
      output.push(line);
      const close = line.replace(/^ {0,3}/, "").trim();
      if (close && close.split("").every(char => char === fence.char) && close.length >= fence.length) fence = null;
      continue;
    }
    plain += line;
  }
  flush();
  return output.join("");
}

function containsOutsideCode(markdown, pattern) {
  let found = false;
  transformOutsideCode(markdown, fragment => {
    if (pattern.test(fragment.replace(/\\</g, ""))) found = true;
    return fragment;
  });
  return found;
}

function convertNotionMarkdown(markdown) {
  const reasons = new Set();
  const converted = transformOutsideCode(markdown, fragment => {
    const tree = parseNotionMarkup(fragment);
    return tree.children.map(node => renderNotionNode(node,{depth:0,reasons})).join("");
  }).replace(/\n{3,}/g,"\n\n");
  if (containsOutsideCode(converted, UNSUPPORTED_NOTION_BLOCK)) throw new TransferError("notion_markdown_conversion_incomplete");
  return { markdown: converted, conversionReasons: [...reasons].sort() };
}

function validateMarkdown(result) {
  if (typeof result?.markdown !== "string" || !result.markdown.trim()) throw new TransferError("notion_markdown_empty");
  if (result.truncated === true) throw new TransferError("notion_markdown_truncated");
  if (Array.isArray(result.unknown_block_ids) && result.unknown_block_ids.length) throw new TransferError("notion_markdown_unknown_blocks");
  if (result.markdown.length > MAX_MARKDOWN_CHARS) throw new TransferError("note_too_large");
  if (containsOutsideCode(result.markdown, UNSUPPORTED_NOTION_MEDIA)) throw new TransferError("notion_uploaded_media_not_portable");
  const converted = convertNotionMarkdown(result.markdown);
  if (!converted.markdown.trim()) throw new TransferError("notion_markdown_empty");
  if (converted.markdown.length > MAX_MARKDOWN_CHARS) throw new TransferError("note_too_large");
  return converted;
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
    // The API filter should put eligible rows on the first page. Stop as soon
    // as one exists; pagination is only a fallback for inconsistent filters.
    if (pages.some((item) => ["未処理", "処理中"].includes(pageStatus(item, statusProperty)))) return pages;
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

  let markdownResult;
  try {
    markdownResult = await readMarkdown(env, fetchImpl, pageId);
  } catch (error) {
    if (["notion_markdown_empty", "notion_markdown_truncated", "notion_markdown_unknown_blocks",
      "note_too_large", "notion_uploaded_media_not_portable", "notion_markdown_conversion_incomplete"].includes(error.code)) {
      await updateStatus(env, fetchImpl, pageId, "要確認");
      return { outcome: "review", reason: error.code, pageId, path };
    }
    throw error;
  }
  const markdown = markdownResult.markdown;
  if (markdownResult.conversionReasons.length) logger.info("notion_markdown_converted", { pageId, reasons: markdownResult.conversionReasons });
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
