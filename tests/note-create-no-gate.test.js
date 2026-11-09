import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// 2026-11-09 の所有者決定: ノート書き込み時の認証情報スキャンが
// ai_allowed=0 / review_state='blocked_credentials' を付ける仕組み
// (Gemini 時代の残骸) は撤去した。このテストは createNote の実挙動を
// 切り出して実行し、かつて遮断された実文が通常どおり保存されることを
// 確かめる。フィクスチャは 2026-11-09 に本番で実際に遮断された
// 申し送りノートの本文 (watch token の登録手順の説明文) を使う。

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function createNote(request, env) {");
const marker = '__name(createNote, "createNote");';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "Could not extract createNote from the Worker bundle");
const createNoteSource = source.slice(start, end);

function readUuid(content) {
  const fm = String(content || "").slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm?.[1].match(/^id:\s*["']?([0-9A-Za-z-]+)["']?\s*$/m)?.[1] ?? null;
}
function isValidSyncUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function makeDb() {
  const statements = [];
  const db = {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...args) { this.values = args; return this; },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; }
      };
      statements.push(statement);
      return statement;
    },
    async batch(batchStatements) {
      return batchStatements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return db;
}

const deps = {
  readJson: (request) => request.json(),
  json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  stableId: (path) => path.normalize("NFC").replaceAll("\\", "/"),
  titleFrom: (path, supplied) => supplied || path.split("/").at(-1).replace(/\.md$/i, ""),
  sha256: async (text) => createHash("sha256").update(text).digest("hex"),
  extractTags: (_content, tags) => tags || [],
  readUuid,
  isValidSyncUuid,
  MAX_NOTE_CHARS: 500000,
  RESERVED_ROOT: "__system"
};
const createNote = new Function(...Object.keys(deps), "return (" + createNoteSource + ");")(...Object.values(deps));

// 2026-11-09 に本番で blocked_credentials になった実文。
const BLOCKED_IN_PRODUCTION = [
  "# Muse間手紙板の接続手順",
  "",
  "見張りの合図の登録手順: 合言葉で POST /admin/watch-token に {\"side\": \"rainbow\", \"token\": \"自分で作った32字以上の文字列\"} を送ると、その文字列の照合だけが有効になる。GET /watch に X-Side: rainbow と X-Watch-Token: その文字列を付けると、相手側の最新の手紙の番号だけが返る（本文は返らない）。専用の合図は、脚本が読む場所にだけ置き、ノートには書かない。"
].join("\n");

async function create(content) {
  const db = makeDb();
  const request = new Request("https://test/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Notes/AI共有/2026-11-09_Muse間手紙板_接続と運用.md", content })
  });
  const response = await createNote(request, { DB: db });
  return { db, response, body: await response.json() };
}

test("書き込み時のスキャンで遮断された実文が、通常どおり保存される", async () => {
  const { db, response, body } = await create(BLOCKED_IN_PRODUCTION);
  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.aiAllowed, true, "aiAllowed must be true after the gate removal");
  assert.equal(body.reviewState, "ready", "reviewState must be ready after the gate removal");
  const insert = db.statements.find((statement) => statement.sql.startsWith("INSERT INTO notes"));
  assert.ok(insert, "the note row must be inserted");
  assert.equal(insert.values[4], BLOCKED_IN_PRODUCTION, "content must be stored verbatim");
  assert.equal(insert.values[9], 1, "ai_allowed column must be stored as 1");
  assert.equal(insert.values[10], "unknown", "sensitivity column must be stored as unknown");
  assert.equal(insert.values[11], "ready", "review_state column must be stored as ready");
});

test("通常のノートも aiAllowed=true / reviewState=ready で保存される", async () => {
  const { response, body } = await create("# メモ\n\n通常の本文。");
  assert.equal(response.status, 201);
  assert.equal(body.aiAllowed, true);
  assert.equal(body.reviewState, "ready");
});
