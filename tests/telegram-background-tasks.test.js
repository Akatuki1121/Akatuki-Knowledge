// Issue #86: src/telegram-background-tasks.mjs のモジュール契約テスト。
// 背景タスクの Telegram ハンドラ (状態確認・取消・一覧) を index.js から分離したため、
// 文字列抽出ではなくモジュールの振る舞いで検証する。状態確認・取消は #90 で
// 実測検証済みの経路であり、文言・chat スコープの認可形状・Workflow terminate の
// 条件を固定する。D1 はインメモリフェイクで agent_tasks の SQL 意味論
// (background-task-store.mjs が発行する文だけ) を再現する。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTelegramBackgroundTasks } from "../src/telegram-background-tasks.mjs";

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
assert.ok(workerSource.includes('from "./telegram-background-tasks.mjs"'), "the Worker entry point must import the telegram background tasks module");
assert.ok(workerSource.includes("createTelegramBackgroundTasks({ describeAgentTaskStopReason })"), "the Worker entry point must build the handlers through the factory with the stop-reason guidance injected");

// 停止理由の説明は現時点では index.js にあり、順位2 で background-task-policy.mjs へ移る。
// どちらの配置でも実物を注入して検証できるよう、定義がある側から関数本文を取り出す。
const policySource = await readFile(new URL("../src/background-task-policy.mjs", import.meta.url), "utf8");
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}
const guidanceSource = [workerSource, policySource].find((s) => s.includes("function describeAgentTaskStopReason"));
const describeAgentTaskStopReason = new Function(
  `${extractFunction(guidanceSource, "describeAgentTaskStopReason")}; return describeAgentTaskStopReason;`
)();

const { getTelegramBackgroundTaskStatus, cancelTelegramBackgroundTask, listTelegramBackgroundTasks } =
  createTelegramBackgroundTasks({ describeAgentTaskStopReason });

function makeRow(overrides = {}) {
  return {
    task_id: "task-1",
    task_type: "knowledge_query",
    status: "queued",
    attempts: 0,
    max_attempts: 4,
    created_at: "2026-10-25 10:00:00",
    updated_at: "2026-10-25 10:00:00",
    next_attempt_at: "2026-10-25 10:00:00",
    stop_reason: null,
    last_error_class: null,
    payload_json: "{}",
    checkpoint_json: "{}",
    notify_chat_id: "chat-a",
    notification_status: "none",
    notification_attempts: 0,
    notification_last_error_class: null,
    completed_at: null,
    lease_token: null,
    lease_expires_at: null,
    ...overrides
  };
}

// agent_tasks テーブルのインメモリフェイク。background-task-store.mjs が発行する
// 3 種の文 (getAgentTask / listAgentTasks / cancelAgentTask) の意味論だけを再現する。
// failOn に文の断片を入れるとその文で例外を投げる。
function createFakeDb(rows, { failOn = null } = {}) {
  const byId = new Map(rows.map((row) => [row.task_id, row]));
  const matches = (sql) => failOn && sql.includes(failOn);
  function prepare(sql) {
    return {
      bind(...args) {
        return {
          async first() {
            if (matches(sql)) throw new Error("fake D1 failure");
            if (sql.includes("UPDATE agent_tasks")) {
              const [completedAt, updatedAt, taskId, chatId] = args;
              const row = byId.get(taskId);
              if (row && String(row.notify_chat_id ?? "") === chatId && ["queued", "running", "waiting"].includes(row.status)) {
                row.status = "cancelled";
                row.stop_reason = "user_cancelled";
                row.completed_at = completedAt;
                row.updated_at = updatedAt;
                row.lease_token = null;
                row.lease_expires_at = null;
                row.notification_status = "sent";
                return { task_id: row.task_id };
              }
              return null;
            }
            if (sql.includes("SELECT status, notify_chat_id FROM agent_tasks")) {
              const row = byId.get(args[0]);
              return row ? { status: row.status, notify_chat_id: row.notify_chat_id } : null;
            }
            if (sql.includes("SELECT * FROM agent_tasks WHERE task_id")) {
              return byId.get(args[0]) ?? null;
            }
            throw new Error("unexpected first() SQL: " + sql.slice(0, 80));
          },
          async all() {
            if (matches(sql)) throw new Error("fake D1 failure");
            if (sql.includes("ORDER BY updated_at DESC")) {
              const status = args[0];
              const notifyChatId = args[6];
              const limit = args[8];
              const active = ["queued", "running", "waiting"];
              const out = [...byId.values()].filter((row) => {
                const statusOk = status === "active" ? active.includes(row.status)
                  : status === "terminal" ? ["succeeded", "failed", "cancelled"].includes(row.status)
                  : status === "all" ? true
                  : row.status === status;
                const chatOk = notifyChatId == null || String(row.notify_chat_id ?? "") === notifyChatId;
                return statusOk && chatOk;
              });
              out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              return { results: out.slice(0, limit) };
            }
            throw new Error("unexpected all() SQL: " + sql.slice(0, 80));
          },
          async run() {
            throw new Error("unexpected run() SQL: " + sql.slice(0, 80));
          }
        };
      }
    };
  }
  return { prepare, byId };
}

function createWorkflowStub({ failTerminate = false } = {}) {
  const calls = { get: [], terminate: 0 };
  const binding = {
    async get(taskId) {
      calls.get.push(taskId);
      return {
        async terminate() {
          calls.terminate++;
          if (failTerminate) throw new Error("instance already ended");
        }
      };
    }
  };
  return { binding, calls };
}

test("status: task id is required and unknown ids are reported", async () => {
  const env = { DB: createFakeDb([makeRow()]) };
  assert.equal(await getTelegramBackgroundTaskStatus(env, ""), "使い方: /task_status タスクID");
  assert.equal(await getTelegramBackgroundTaskStatus(env, "missing"), "そのタスクIDは見つかりませんでした。");
});

test("status: database failures are reported without details", async () => {
  const env = { DB: createFakeDb([makeRow()], { failOn: "SELECT * FROM agent_tasks" }) };
  assert.equal(await getTelegramBackgroundTaskStatus(env, "task-1"), "タスク状態を取得できませんでした。");
});

test("status: queued task renders the base lines only", async () => {
  const env = { DB: createFakeDb([makeRow({ notify_chat_id: null })]) };
  const reply = await getTelegramBackgroundTaskStatus(env, "task-1");
  assert.ok(reply.startsWith("背景タスク: 受付済み\nID: task-1\n試行回数: 0/4"));
  assert.ok(!reply.includes("段階:"), "no stage line without a checkpoint stage");
  assert.ok(!reply.includes("通知:"), "no notification line without a notify chat");
});

test("status: stage, update time and notification state are localized", async () => {
  const env = {
    DB: createFakeDb([makeRow({
      status: "running",
      attempts: 2,
      updated_at: "2026-10-25 11:30:00",
      checkpoint_json: JSON.stringify({ stage: "context_ready" }),
      notification_status: "pending"
    })])
  };
  const reply = await getTelegramBackgroundTaskStatus(env, "task-1");
  assert.ok(reply.includes("背景タスク: 実行中"));
  assert.ok(reply.includes("試行回数: 2/4"));
  assert.ok(reply.includes("段階: 関連ノートの取得完了"));
  assert.ok(reply.includes("最終更新: 2026-10-25 11:30:00 UTC"));
  assert.ok(reply.includes("通知: 通知待ち"));
});

test("status: unknown stages fall back to the raw value", async () => {
  const env = { DB: createFakeDb([makeRow({ checkpoint_json: JSON.stringify({ stage: "custom_stage" }) })]) };
  const reply = await getTelegramBackgroundTaskStatus(env, "task-1");
  assert.ok(reply.includes("段階: custom_stage"));
});

test("status: failed tasks include the stop-reason guidance only for failures", async () => {
  const env = {
    DB: createFakeDb([makeRow({
      status: "failed",
      stop_reason: "task_deadline_exceeded",
      notification_status: "failed",
      notification_last_error_class: "telegram_delivery_failed"
    })])
  };
  const reply = await getTelegramBackgroundTaskStatus(env, "task-1");
  assert.ok(reply.includes("背景タスク: 停止"));
  assert.ok(reply.includes("通知: 通知停止"));
  assert.ok(reply.includes("通知停止理由: telegram_delivery_failed"));
  assert.ok(reply.includes("停止理由: 処理時間の上限に到達"));
  assert.ok(reply.includes("次の操作: 依頼を小さく分け、新しい /task として依頼してください。"));

  const prefixed = {
    DB: createFakeDb([makeRow({ status: "failed", stop_reason: "non_retryable_credentials_detected" })])
  };
  const prefixedReply = await getTelegramBackgroundTaskStatus(prefixed, "task-1");
  assert.ok(prefixedReply.includes("停止理由: 認証情報を検出"), "non_retryable_ prefix must be normalized by the guidance");

  const running = { DB: createFakeDb([makeRow({ status: "running", stop_reason: "task_deadline_exceeded" })]) };
  const runningReply = await getTelegramBackgroundTaskStatus(running, "task-1");
  assert.ok(!runningReply.includes("停止理由:"), "stop reason block appears only for failed tasks");
});

test("status: succeeded results are truncated to 3000 characters", async () => {
  const result = "あ".repeat(3500);
  const env = {
    DB: createFakeDb([makeRow({
      status: "succeeded",
      checkpoint_json: JSON.stringify({ stage: "completed", result })
    })])
  };
  const reply = await getTelegramBackgroundTaskStatus(env, "task-1");
  assert.ok(reply.includes("段階: 結果の保存完了"));
  assert.ok(reply.includes("あ".repeat(3000)));
  assert.ok(!reply.includes("あ".repeat(3001)), "result must be cut at 3000 characters");
});

test("list: empty and database failure cases", async () => {
  const env = { DB: createFakeDb([makeRow({ status: "succeeded" })]) };
  assert.equal(await listTelegramBackgroundTasks(env, "chat-a"), "未完了の背景タスクはありません。");
  const failing = { DB: createFakeDb([makeRow()], { failOn: "ORDER BY updated_at DESC" }) };
  assert.equal(await listTelegramBackgroundTasks(failing, "chat-a"), "背景タスク一覧を取得できませんでした。");
});

test("list: only the requesting chat's active tasks are shown", async () => {
  const env = {
    DB: createFakeDb([
      makeRow({ task_id: "mine-queued", status: "queued", updated_at: "2026-10-25 10:00:00" }),
      makeRow({
        task_id: "mine-waiting", status: "waiting", attempts: 1, updated_at: "2026-10-25 11:00:00",
        checkpoint_json: JSON.stringify({ stage: "completed" }), notification_status: "pending"
      }),
      makeRow({ task_id: "other-chat", status: "running", notify_chat_id: "chat-b", updated_at: "2026-10-25 12:00:00" }),
      makeRow({ task_id: "mine-done", status: "succeeded", updated_at: "2026-10-25 12:30:00" })
    ])
  };
  const reply = await listTelegramBackgroundTasks(env, "chat-a");
  assert.ok(reply.startsWith("未完了の背景タスク（2件）:"));
  assert.ok(reply.includes("mine-queued"));
  assert.ok(reply.includes("状態: 受付済み / 試行 0/4"));
  assert.ok(reply.includes("mine-waiting"));
  assert.ok(reply.includes("状態: 再試行待ち / 試行 1/4"));
  assert.ok(reply.includes("段階: 結果保存済み"), "list uses its own stage label for completed");
  assert.ok(reply.includes("通知: 通知待ち"));
  assert.ok(!reply.includes("other-chat"), "other chats' tasks must not leak into the list");
  assert.ok(!reply.includes("mine-done"), "terminal tasks are not active");
  assert.ok(reply.endsWith("個別の状態・結果: /task_status タスクID"));
});

test("list: at most 10 tasks are shown", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => makeRow({
    task_id: `bulk-${String(i).padStart(2, "0")}`,
    updated_at: `2026-10-25 10:${String(i).padStart(2, "0")}:00`
  }));
  const env = { DB: createFakeDb(rows) };
  const reply = await listTelegramBackgroundTasks(env, "chat-a");
  assert.ok(reply.startsWith("未完了の背景タスク（10件）:"));
  assert.ok(reply.includes("bulk-11"), "newest task is included");
  assert.ok(!reply.includes("bulk-00"), "oldest tasks beyond the limit are omitted");
  assert.ok(!reply.includes("bulk-01"), "oldest tasks beyond the limit are omitted");
});

test("cancel: explicit id cancels the own chat's task and terminates the workflow", async () => {
  const db = createFakeDb([makeRow({ status: "running" })]);
  const workflow = createWorkflowStub();
  const env = { DB: db, AGENT_TASK_WORKFLOW: workflow.binding };
  const reply = await cancelTelegramBackgroundTask(env, "chat-a", "task-1");
  // 現行の束縛由来の文言どおり、成功メッセージの区切りはリテラルな \n のまま固定する。
  assert.equal(reply, "キャンセルしました。\\nID: task-1\\n結果の保存・完了通知は行われません。すでに送信された外部API処理は相手側で完了する場合があります。");
  assert.equal(db.byId.get("task-1").status, "cancelled");
  assert.equal(db.byId.get("task-1").stop_reason, "user_cancelled");
  assert.deepEqual(workflow.calls.get, ["task-1"]);
  assert.equal(workflow.calls.terminate, 1);
});

test("cancel: tasks of other chats cannot be cancelled and are not terminated", async () => {
  const db = createFakeDb([makeRow({ status: "running", notify_chat_id: "chat-b" })]);
  const workflow = createWorkflowStub();
  const env = { DB: db, AGENT_TASK_WORKFLOW: workflow.binding };
  const reply = await cancelTelegramBackgroundTask(env, "chat-a", "task-1");
  assert.equal(reply, "タスクが見つからないか、このチャットからキャンセルできません。\nID: task-1");
  assert.equal(db.byId.get("task-1").status, "running");
  assert.deepEqual(workflow.calls.get, []);
  assert.equal(workflow.calls.terminate, 0);
});

test("cancel: unknown, already cancelled and terminal tasks are reported distinctly", async () => {
  const env = {
    DB: createFakeDb([
      makeRow({ task_id: "gone", status: "cancelled" }),
      makeRow({ task_id: "done", status: "succeeded" })
    ])
  };
  assert.equal(
    await cancelTelegramBackgroundTask(env, "chat-a", "missing"),
    "タスクが見つからないか、このチャットからキャンセルできません。\nID: missing"
  );
  assert.equal(
    await cancelTelegramBackgroundTask(env, "chat-a", "gone"),
    "このタスクはすでにキャンセル済みです。\nID: gone"
  );
  assert.equal(
    await cancelTelegramBackgroundTask(env, "chat-a", "done"),
    "このタスクはすでに終了しています（状態: succeeded）。\nID: done"
  );
});

test("cancel: without an id the latest active task of the own chat is cancelled", async () => {
  const db = createFakeDb([
    makeRow({ task_id: "older", status: "queued", updated_at: "2026-10-25 10:00:00" }),
    makeRow({ task_id: "newer", status: "running", updated_at: "2026-10-25 11:00:00" }),
    makeRow({ task_id: "other-newest", status: "running", notify_chat_id: "chat-b", updated_at: "2026-10-25 12:00:00" })
  ]);
  const workflow = createWorkflowStub();
  const env = { DB: db, AGENT_TASK_WORKFLOW: workflow.binding };
  const reply = await cancelTelegramBackgroundTask(env, "chat-a", "");
  assert.ok(reply.includes("ID: newer"), "the newest own-chat task is the fallback target");
  assert.equal(db.byId.get("newer").status, "cancelled");
  assert.equal(db.byId.get("older").status, "queued");
  assert.equal(db.byId.get("other-newest").status, "running");
  assert.deepEqual(workflow.calls.get, ["newer"]);
});

test("cancel: no active task to cancel", async () => {
  const env = { DB: createFakeDb([makeRow({ status: "succeeded" })]) };
  assert.equal(await cancelTelegramBackgroundTask(env, "chat-a", ""), "キャンセルできる未完了タスクはありません。");
});

test("cancel: termination is best-effort and the binding is optional", async () => {
  const dbNoBinding = createFakeDb([makeRow({ status: "queued" })]);
  const replyNoBinding = await cancelTelegramBackgroundTask({ DB: dbNoBinding }, "chat-a", "task-1");
  assert.ok(replyNoBinding.startsWith("キャンセルしました。"));
  assert.equal(dbNoBinding.byId.get("task-1").status, "cancelled");

  const dbFailing = createFakeDb([makeRow({ status: "running" })]);
  const workflow = createWorkflowStub({ failTerminate: true });
  const replyFailing = await cancelTelegramBackgroundTask(
    { DB: dbFailing, AGENT_TASK_WORKFLOW: workflow.binding }, "chat-a", "task-1"
  );
  assert.ok(replyFailing.startsWith("キャンセルしました。"), "a failed terminate must not undo the persisted cancellation");
  assert.equal(workflow.calls.terminate, 1);
  assert.equal(dbFailing.byId.get("task-1").status, "cancelled");
});

test("cancel: database failures are reported without details", async () => {
  const lookupFailing = { DB: createFakeDb([makeRow()], { failOn: "ORDER BY updated_at DESC" }) };
  assert.equal(
    await cancelTelegramBackgroundTask(lookupFailing, "chat-a", ""),
    "実行中タスクを確認できませんでした。"
  );
  const updateFailing = { DB: createFakeDb([makeRow()], { failOn: "UPDATE agent_tasks" }) };
  assert.equal(
    await cancelTelegramBackgroundTask(updateFailing, "chat-a", "task-1"),
    "キャンセル要求を保存できませんでした。少し待って /task_status task-1 で確認してください。"
  );
});
