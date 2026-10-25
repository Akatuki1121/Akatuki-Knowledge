import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const start = source.indexOf("const MEASUREMENT_UPDATE_ID_RANGES = [");
const end = source.indexOf("\nasync function correctNote(", start);
assert.ok(start >= 0 && end > start, "Could not extract the measurement cleanup block");
const block = source.slice(start, end).trim();

const __name = (fn) => fn;
const { MEASUREMENT_UPDATE_ID_RANGES, measurementUpdateId, isMeasurementNoteId, cleanupMeasurementNotes } =
  new Function("__name", block + "\nreturn { MEASUREMENT_UPDATE_ID_RANGES, measurementUpdateId, isMeasurementNoteId, cleanupMeasurementNotes };")(__name);

assert.deepEqual(MEASUREMENT_UPDATE_ID_RANGES, [[9100001037, 9100001072], [9100002001, 9100002036]]);

// 範囲指定そのものの固定: 境界の内側だけが対象で、範囲外の行は決して対象にならない。
for (const id of [
  "tg:4242424242:9100001037", // セッションB の下限
  "tg:4242424242:9100001072", // セッションB の上限
  "tg:4242424242:9100002001", // セッションA再送の下限
  "tg:4242424242:9100002036", // セッションA再送の上限
  "tg:-1004242424242:9100001050" // グループ chat_id (負数) でも形式が合えば対象
]) {
  assert.equal(isMeasurementNoteId(id), true, `expected in scope: ${id}`);
}
for (const id of [
  "tg:4242424242:9100001036", // B の1つ手前
  "tg:4242424242:9100001073", // B の1つ後
  "tg:4242424242:9100002000", // A の1つ手前
  "tg:4242424242:9100002037", // A の1つ後
  "tg:4242424242:1", // 実利用の小さい update_id
  "tg:4242424242:12345",
  "tg:4242424242:987654321",
  "tg:4242424242:9100001050x", // 末尾に余分な文字
  "tg:4242424242:9100001050:99", // セグメント過多
  "tg:9100001050", // chat_id セグメント欠落
  "tg:abc:9100001050", // chat_id が数値でない
  "9100001050", // tg: プレフィックスなし
  "Notes/example.md", // 通常ノートの id
  "",
  null,
  undefined
]) {
  assert.equal(isMeasurementNoteId(id), false, `expected out of scope: ${id}`);
}
assert.equal(measurementUpdateId("tg:-1004242424242:9100002036"), 9100002036);
assert.equal(measurementUpdateId("tg:4242424242:12345"), 12345);
assert.equal(measurementUpdateId("not-a-telegram-id"), null);

function fakeDb(rows) {
  return {
    prepare(sql) {
      if (sql === "SELECT id FROM telegram_notes WHERE deleted_at IS NULL") {
        return { all: async () => ({ results: rows.filter((row) => row.deleted_at === null).map((row) => ({ id: row.id })) }) };
      }
      if (sql === "UPDATE telegram_notes SET deleted_at = ?, ai_allowed = 0, review_state = 'deleted' WHERE id = ? AND deleted_at IS NULL") {
        return {
          bind(...args) {
            return {
              run: async () => {
                const [now, id] = args;
                const row = rows.find((item) => item.id === id);
                if (!row || row.deleted_at !== null) return { meta: { changes: 0 } };
                row.deleted_at = now;
                row.ai_allowed = 0;
                row.review_state = "deleted";
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
      throw new Error("Unexpected SQL in test: " + sql);
    },
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
}

const inRangeIds = [
  ...Array.from({ length: 11 }, (_, i) => `tg:4242424242:${9100001037 + i}`), // セッションB 相当 11件
  ...Array.from({ length: 18 }, (_, i) => `tg:4242424242:${9100002001 + i}`) // セッションA再送 相当 18件
];
const outOfRangeIds = [
  "tg:4242424242:9100001036",
  "tg:4242424242:9100001073",
  "tg:4242424242:9100002000",
  "tg:4242424242:9100002037",
  "tg:4242424242:12345" // 実利用行相当
];

function setup() {
  const rows = [
    ...inRangeIds.map((id) => ({ id, deleted_at: null, ai_allowed: 1, review_state: "ready" })),
    ...outOfRangeIds.map((id) => ({ id, deleted_at: null, ai_allowed: 1, review_state: "ready" })),
    { id: "tg:4242424242:9100001050", deleted_at: "2026-10-25T00:00:00.000Z", ai_allowed: 0, review_state: "deleted" } // 範囲内だがアーカイブ済み
  ];
  return { env: { DB: fakeDb(rows) }, rows };
}

{
  const { env, rows } = setup();
  const result = await cleanupMeasurementNotes(env, false);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.targets, 29, "dry-run counts only in-range, not-yet-archived rows");
  assert.equal(result.archived, 0);
  assert.ok(rows.every((row) => row.id === "tg:4242424242:9100001050" ? row.deleted_at === "2026-10-25T00:00:00.000Z" : row.deleted_at === null), "Dry-run must not modify rows");
}

{
  const { env, rows } = setup();
  const result = await cleanupMeasurementNotes(env, true);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.targets, 29);
  assert.equal(result.archived, 29);
  for (const row of rows) {
    if (inRangeIds.includes(row.id)) {
      assert.ok(row.deleted_at !== null, `in-range row archived: ${row.id}`);
      assert.equal(row.ai_allowed, 0);
      assert.equal(row.review_state, "deleted");
    } else if (row.id === "tg:4242424242:9100001050") {
      assert.equal(row.deleted_at, "2026-10-25T00:00:00.000Z", "previously archived row keeps its original timestamp");
    } else {
      assert.equal(row.deleted_at, null, `out-of-range row untouched: ${row.id}`);
      assert.equal(row.review_state, "ready");
    }
  }

  const again = await cleanupMeasurementNotes(env, true);
  assert.equal(again.ok, true);
  assert.equal(again.targets, 0, "Cleanup is idempotent");
  assert.equal(again.archived, 0);
}

{
  const { env } = setup();
  const empty = await cleanupMeasurementNotes({ DB: fakeDb([]) }, true);
  assert.equal(empty.ok, true);
  assert.equal(empty.targets, 0);
  assert.equal(empty.archived, 0);
  void env;
}

console.log("Measurement-note cleanup tests passed.");
