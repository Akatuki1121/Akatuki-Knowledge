// 宣言された fileId による移動 API の同一性マッピング確立を検証する。
// src/index.js から createNote と moveNote を抽出し、モック D1 上で実行する。
// 作成直後のノートでも pull を挟まずに移動できること、誤った fileId は
// fail-closed で拒否されること、確立したマッピングが pull 由来と同一に
// 扱われることを確認する。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

function handlerSlice(name) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`__name(${name}, "${name}");`, start);
  if (start === -1 || end === -1) throw new Error(`handler not found: ${name}`);
  return source.slice(start, end);
}

function buildHandler(name, globals) {
  const names = Object.keys(globals);
  const values = names.map((key) => globals[key]);
  const factory = new Function(...names, `${handlerSlice(name)}\nreturn ${name};`);
  return factory(...values);
}

const json = (data, status = 200) => ({ data, status, ok: status < 400 });
const readJson = async (request) => request.body;
const stableId = (path) => path.normalize("NFC").replaceAll("\\", "/");
const titleFrom = (path, supplied) => {
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim().slice(0, 300);
  const filename = path.split("/").pop() || path;
  return filename.replace(/\.md$/i, "").replace(/[_-]+/g, " ");
};
const sha256 = async (value) => createHash("sha256").update(value).digest("hex");
const isValidSyncUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const readUuid = () => null;
const inspectWholeContent = () => ({ credentials: null });
const extractTags = () => [];
const noteIdFromRoute = (url, suffix = "") => {
  const escapedSuffix = suffix ? `/${suffix}` : "";
  const match = url.pathname.match(new RegExp(`^/api/notes/(.+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
};
const prepareSyncJob = async () => ({ statements: [] });
const RESERVED_ROOT = "System";
const MAX_NOTE_CHARS = 500000;

const globals = {
  json,
  readJson,
  stableId,
  titleFrom,
  sha256,
  isValidSyncUuid,
  readUuid,
  inspectWholeContent,
  extractTags,
  noteIdFromRoute,
  prepareSyncJob,
  RESERVED_ROOT,
  MAX_NOTE_CHARS,
};

const createNote = buildHandler("createNote", globals);
const moveNote = buildHandler("moveNote", globals);

function createMockDb() {
  const state = { notes: [], mappings: [], jobs: [] };
  const findNote = (predicate) => state.notes.find(predicate) || null;
  const findMapping = (predicate) => state.mappings.find(predicate) || null;
  function makeStatement(sql, params) {
    const first = async () => {
      if (sql.includes("FROM note_revisions")) return null;
      if (sql.includes("FROM yaos_file_identity_map WHERE last_path = ? AND file_id <> ?")) {
        return findMapping((m) => m.last_path === params[0] && m.file_id !== params[1]);
      }
      if (sql.includes("FROM yaos_file_identity_map WHERE file_id = ?")) {
        return findMapping((m) => m.file_id === params[0]);
      }
      if (sql.includes("FROM yaos_file_identity_map WHERE last_path = ?")) {
        return findMapping((m) => m.last_path === params[0]);
      }
      if (sql.includes("FROM notes WHERE path = ? AND deleted_at IS NULL AND id <> ?")) {
        return findNote((n) => n.path === params[0] && !n.deleted_at && n.id !== params[1]);
      }
      if (sql.includes("FROM notes WHERE sync_uuid = ? AND id <> ? AND deleted_at IS NULL")) {
        return findNote((n) => n.sync_uuid === params[0] && !n.deleted_at && n.id !== params[1]);
      }
      if (sql.includes("FROM notes WHERE path = ? AND deleted_at IS NULL")) {
        return findNote((n) => n.path === params[0] && !n.deleted_at);
      }
      if (sql.includes("FROM notes WHERE path = ?")) {
        return findNote((n) => n.path === params[0]);
      }
      if (sql.includes("FROM notes WHERE sync_uuid = ?")) {
        return findNote((n) => n.sync_uuid === params[0]);
      }
      return null;
    };
    const all = async () => {
      if (sql.includes("FROM yaos_file_identity_map WHERE note_id = ? OR sync_uuid = ?")) {
        return {
          results: state.mappings.filter((m) => m.note_id === params[0] || m.sync_uuid === params[1]),
        };
      }
      return { results: [] };
    };
    const run = async () => {
      if (sql.startsWith("INSERT INTO notes")) {
        state.notes.push({
          id: params[0],
          path: params[1],
          sync_uuid: params[2],
          title: params[3],
          content: params[4],
          content_hash: params[5],
          source_modified_at: null,
          imported_at: params[6],
          updated_at: params[7],
          tags_json: params[8],
          ai_allowed: params[9],
          sensitivity: params[10],
          review_state: params[11],
          deleted_at: null,
        });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("INSERT INTO yaos_sync_jobs")) {
        state.jobs.push({ event_id: params[0], entity_id: params[1], payload_json: params[2] });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("INSERT INTO yaos_file_identity_map")) {
        if (
          state.mappings.some(
            (m) => m.file_id === params[0] || m.sync_uuid === params[1] || m.note_id === params[2],
          )
        ) {
          throw new Error("UNIQUE constraint failed: yaos_file_identity_map");
        }
        state.mappings.push({
          file_id: params[0],
          sync_uuid: params[1],
          note_id: params[2],
          last_path: params[3],
          created_at: params[4],
          updated_at: params[5],
        });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("UPDATE notes SET path")) {
        const note = findNote((n) => n.id === params[1] && n.path === params[2] && !n.deleted_at);
        const mapping = findMapping(
          (m) =>
            m.file_id === params[3] &&
            m.note_id === params[4] &&
            m.sync_uuid === params[5] &&
            m.last_path === params[6],
        );
        if (note && mapping) {
          note.path = params[0];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.startsWith("UPDATE yaos_file_identity_map SET last_path")) {
        const mapping = findMapping(
          (m) =>
            m.file_id === params[2] &&
            m.note_id === params[3] &&
            m.sync_uuid === params[4] &&
            m.last_path === params[5],
        );
        const note = findNote((n) => n.id === params[6] && n.path === params[7] && !n.deleted_at);
        if (mapping && note) {
          mapping.last_path = params[0];
          mapping.updated_at = params[1];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      return { meta: { changes: 0 } };
    };
    return { first, all, run };
  }
  const db = {
    prepare: (sql) => ({ bind: (...params) => makeStatement(sql, params) }),
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return { db, state };
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}: ${error.message}`);
  }
}

async function create(db, path, content) {
  const response = await createNote({ body: { path, content } }, { DB: db });
  assert(response.ok, `create ${path} should succeed, got ${JSON.stringify(response.data)}`);
  return response.data;
}

async function move(db, currentPath, body) {
  const url = { pathname: `/api/notes/${encodeURIComponent(currentPath)}/move` };
  return moveNote({ body }, url, { DB: db });
}

const contentA = "# テストA\n本文A\n";
const contentB = "# テストB\n本文B\n";

await test("宣言 fileId による作成直後の移動が成功し、マッピングが確立される", async () => {
  const { db, state } = createMockDb();
  const created = await create(db, "Notes/Test/作った直後.md", contentA);
  const before = state.notes.find((n) => n.id === created.id);
  const beforeUpdatedAt = before.updated_at;
  const beforeImportedAt = before.imported_at;
  const response = await move(db, "Notes/Test/作った直後.md", {
    newPath: "Notes/Test/移動後.md",
    fileId: "vault-file-a",
    expectedContentHash: created.contentHash,
  });
  equal(response.status, 200, "移動のステータス");
  equal(response.data.ok, true, "移動の ok");
  equal(response.data.syncUuid, created.syncUuid, "syncUuid が保持される");
  equal(response.data.path, "Notes/Test/移動後.md", "移動先パス");
  equal(response.data.oldPath, "Notes/Test/作った直後.md", "移動元パス");
  const note = state.notes.find((n) => n.id === created.id);
  equal(note.path, "Notes/Test/移動後.md", "ノートのパスが更新される");
  equal(note.content, contentA, "本文は変わらない");
  equal(note.content_hash, created.contentHash, "content_hash は変わらない");
  equal(note.updated_at, beforeUpdatedAt, "updated_at は変わらない");
  equal(note.imported_at, beforeImportedAt, "imported_at は変わらない");
  equal(state.mappings.length, 1, "マッピングが1件確立される");
  equal(state.mappings[0].file_id, "vault-file-a", "マッピングの file_id");
  equal(state.mappings[0].note_id, created.id, "マッピングの note_id");
  equal(state.mappings[0].sync_uuid, created.syncUuid, "マッピングの sync_uuid");
  equal(state.mappings[0].last_path, "Notes/Test/移動後.md", "マッピングの last_path は移動先");
  const second = await move(db, "Notes/Test/移動後.md", { newPath: "Notes/Test/再移動後.md" });
  equal(second.status, 200, "fileId なしの後続移動が成功する");
  equal(state.mappings[0].last_path, "Notes/Test/再移動後.md", "後続移動で last_path が更新される");
  equal(state.mappings[0].file_id, "vault-file-a", "後続移動で file_id は変わらない");
  const conflict = await move(db, "Notes/Test/再移動後.md", {
    newPath: "Notes/Test/三度目.md",
    fileId: "vault-file-other",
  });
  equal(conflict.status, 409, "確立済みと異なる fileId は拒否される");
  equal(conflict.data.error, "sync_identity_mapping_conflict", "確立済みと異なる fileId のエラー");
  equal(
    state.notes.find((n) => n.id === created.id).path,
    "Notes/Test/再移動後.md",
    "拒否された移動でパスは変わらない",
  );
});

await test("別のノートのマッピングが使う fileId は拒否される", async () => {
  const { db, state } = createMockDb();
  const a = await create(db, "Notes/Test/A.md", contentA);
  const moved = await move(db, "Notes/Test/A.md", { newPath: "Notes/Test/A2.md", fileId: "shared-file" });
  equal(moved.status, 200, "最初の移動が成功する");
  const b = await create(db, "Notes/Test/B.md", contentB);
  const response = await move(db, "Notes/Test/B.md", { newPath: "Notes/Test/B2.md", fileId: "shared-file" });
  equal(response.status, 409, "他ノートの fileId は拒否される");
  equal(response.data.error, "sync_identity_mapping_conflict", "他ノートの fileId のエラー");
  equal(state.notes.find((n) => n.id === b.id).path, "Notes/Test/B.md", "拒否されたノートのパスは変わらない");
  equal(state.mappings.length, 1, "マッピングは増えない");
  equal(state.mappings[0].note_id, a.id, "既存マッピングは変わらない");
});

await test("別パスにあるマッピングの fileId は拒否される", async () => {
  const { db, state } = createMockDb();
  state.mappings.push({
    file_id: "other-path-file",
    sync_uuid: "11111111-1111-4111-8111-111111111111",
    note_id: "Notes/Test/Other.md",
    last_path: "Notes/Test/Other.md",
    created_at: "2026-10-30T00:00:00.000Z",
    updated_at: "2026-10-30T00:00:00.000Z",
  });
  const created = await create(db, "Notes/Test/Target.md", contentA);
  const response = await move(db, "Notes/Test/Target.md", {
    newPath: "Notes/Test/Target2.md",
    fileId: "other-path-file",
  });
  equal(response.status, 409, "別パスのマッピングの fileId は拒否される");
  equal(response.data.error, "sync_identity_mapping_conflict", "別パスのマッピングの fileId のエラー");
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/Target.md", "パスは変わらない");
  equal(state.mappings.length, 1, "マッピングは増えない");
});

await test("現在パスを別マッピングが主張している場合は新規 fileId でも拒否される", async () => {
  const { db, state } = createMockDb();
  state.mappings.push({
    file_id: "path-claim-file",
    sync_uuid: "22222222-2222-4222-8222-222222222222",
    note_id: "Notes/Test/Claimer.md",
    last_path: "Notes/Test/Target.md",
    created_at: "2026-10-30T00:00:00.000Z",
    updated_at: "2026-10-30T00:00:00.000Z",
  });
  const created = await create(db, "Notes/Test/Target.md", contentA);
  const response = await move(db, "Notes/Test/Target.md", {
    newPath: "Notes/Test/Target2.md",
    fileId: "fresh-file",
  });
  equal(response.status, 409, "現在パスが主張されている場合は拒否される");
  equal(response.data.error, "sync_identity_mapping_conflict", "現在パスが主張されている場合のエラー");
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/Target.md", "パスは変わらない");
  equal(state.mappings.length, 1, "マッピングは増えない");
});

await test("マッピングなしで fileId を渡さない場合は従来どおり拒否される", async () => {
  const { db, state } = createMockDb();
  const created = await create(db, "Notes/Test/NoMapping.md", contentA);
  const response = await move(db, "Notes/Test/NoMapping.md", { newPath: "Notes/Test/NoMapping2.md" });
  equal(response.status, 409, "fileId なし・マッピングなしは拒否される");
  equal(response.data.error, "sync_identity_mapping_conflict", "fileId なし・マッピングなしのエラー");
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/NoMapping.md", "パスは変わらない");
  equal(state.mappings.length, 0, "マッピングは作られない");
});

await test("fileId 付きでも誤った expectedContentHash は拒否される", async () => {
  const { db, state } = createMockDb();
  const created = await create(db, "Notes/Test/Hash.md", contentA);
  const response = await move(db, "Notes/Test/Hash.md", {
    newPath: "Notes/Test/Hash2.md",
    fileId: "hash-file",
    expectedContentHash: "0".repeat(64),
  });
  equal(response.status, 409, "誤った expectedContentHash は拒否される");
  equal(response.data.error, "content_hash_precondition_failed", "誤った expectedContentHash のエラー");
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/Hash.md", "パスは変わらない");
  equal(state.mappings.length, 0, "マッピングは作られない");
});

await test("不正な fileId は 400 で拒否される", async () => {
  const { db, state } = createMockDb();
  const created = await create(db, "Notes/Test/BadId.md", contentA);
  for (const fileId of ["", 123]) {
    const response = await move(db, "Notes/Test/BadId.md", {
      newPath: "Notes/Test/BadId2.md",
      fileId,
    });
    equal(response.status, 400, `fileId ${JSON.stringify(fileId)} は 400`);
    equal(response.data.error, "invalid_file_id", `fileId ${JSON.stringify(fileId)} のエラー`);
  }
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/BadId.md", "パスは変わらない");
  equal(state.mappings.length, 0, "マッピングは作られない");
});

await test("fileId が null の場合は未指定と同一に扱われる", async () => {
  const { db, state } = createMockDb();
  const created = await create(db, "Notes/Test/NullId.md", contentA);
  const response = await move(db, "Notes/Test/NullId.md", { newPath: "Notes/Test/NullId2.md", fileId: null });
  equal(response.status, 409, "fileId null・マッピングなしは拒否される");
  equal(response.data.error, "sync_identity_mapping_conflict", "fileId null・マッピングなしのエラー");
  equal(state.notes.find((n) => n.id === created.id).path, "Notes/Test/NullId.md", "パスは変わらない");
});

await test("実装に宣言 fileId の処理が含まれている", async () => {
  for (const fragment of [
    "invalid_file_id",
    "INSERT INTO yaos_file_identity_map (file_id, sync_uuid, note_id, last_path, created_at, updated_at)",
    "declaredMapping",
    "...identityStatements",
  ]) {
    assert(source.includes(fragment), `実装に ${fragment} が含まれる`);
  }
});

await test("観測済みの改名先と一致するマップのパス不一致は安全に修復できる", async () => {
  const { db, state } = createMockDb();
  const oldPath = "Notes/Test/Old.md";
  const observedPath = "Notes/Test/Renamed.md";
  const created = await create(db, oldPath, contentA);
  state.mappings.push({
    file_id: "renamed-file",
    sync_uuid: created.syncUuid,
    note_id: created.id,
    last_path: observedPath,
    created_at: "2026-10-31T14:31:10Z",
    updated_at: "2026-10-31T14:31:10Z",
  });
  const unrelated = await move(db, oldPath, { newPath: "Notes/Test/Unrelated.md", fileId: "renamed-file" });
  equal(unrelated.status, 409, "マップが主張していない移動先は拒否される");
  equal(unrelated.data.error, "sync_identity_mapping_path_mismatch", "実測と同じ409エラー");
  const unrelatedWithoutFileId = await move(db, oldPath, { newPath: "Notes/Test/Unrelated.md" });
  equal(unrelatedWithoutFileId.status, 409, "fileId を省略しても第三のパスは拒否される");
  equal(unrelatedWithoutFileId.data.error, "sync_identity_mapping_path_mismatch", "fileId の有無で拒否理由は変わらない");
  const repaired = await move(db, oldPath, {
    newPath: observedPath,
    fileId: "renamed-file",
    expectedContentHash: created.contentHash,
  });
  equal(repaired.status, 200, "既存マップが主張する改名先への移動は成功する");
  equal(state.notes.find((n) => n.id === created.id).path, observedPath, "D1パスが改名先に揃う");
  equal(state.mappings.length, 1, "同じマッピングだけが残る");
  equal(state.mappings[0].last_path, observedPath, "マップのパスは維持される");
  equal(state.mappings[0].sync_uuid, created.syncUuid, "sync_uuid は維持される");
});

await test("観測済みの改名先は fileId 省略時も移動できる", async () => {
  const { db, state } = createMockDb();
  const oldPath = "Notes/Test/OldWithoutFileId.md";
  const observedPath = "Notes/Test/RenamedWithoutFileId.md";
  const created = await create(db, oldPath, contentA);
  state.mappings.push({
    file_id: "renamed-file-no-declared-id",
    sync_uuid: created.syncUuid,
    note_id: created.id,
    last_path: observedPath,
    created_at: "2026-10-31T14:31:10Z",
    updated_at: "2026-10-31T14:31:10Z",
  });
  const repaired = await move(db, oldPath, { newPath: observedPath });
  equal(repaired.status, 200, "既存マップが要求先を示すなら fileId なしでも成功する");
  equal(state.notes.find((n) => n.id === created.id).path, observedPath);
  equal(state.mappings[0].last_path, observedPath);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
