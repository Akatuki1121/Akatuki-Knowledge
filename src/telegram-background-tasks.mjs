// 背景タスクの Telegram ハンドラ (状態確認・取消・一覧) (Issue #86)。
// src/index.js から移動した関数群。関数本文は移動前と同一。
// store 群 (getAgentTask / listAgentTasks / cancelAgentTask) は
// src/background-task-store.mjs から直接 import する。
// 停止理由の説明 describeAgentTaskStopReason は、順位2 の移設先である
// src/background-task-policy.mjs への移動が未マージのため、それまでは
// index.js 側の定義を注入で受ける (bot-alerts が送信関数を注入する前例と同じ方式)。
// 移設が完了すれば、注入元を import へ差し替えるだけで済む。
// startTelegramBackgroundTask は投入前の伏字・機微ゲートを含むため index.js に残す。
// Worker エントリポイントには依存しない。
import { cancelAgentTask, getAgentTask, listAgentTasks } from "./background-task-store.mjs";

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// 背景タスクの Telegram ハンドラ群を組み立てる。本文は移動前と同一。
export function createTelegramBackgroundTasks({ describeAgentTaskStopReason }) {
async function getTelegramBackgroundTaskStatus(env, taskId) {
  if (!taskId) return "使い方: /task_status タスクID";
  let task;
  try {
    task = await getAgentTask(env.DB, taskId);
  } catch {
    return "タスク状態を取得できませんでした。";
  }
  if (!task) return "そのタスクIDは見つかりませんでした。";

  const labels = {
    queued: "受付済み",
    running: "実行中",
    waiting: "再試行待ち",
    succeeded: "完了",
    failed: "停止",
    cancelled: "キャンセル済み"
  };
  const stageLabels = {
    context_ready: "関連ノートの取得完了",
    prompt_ready: "要約プロンプトの準備完了",
    completed: "結果の保存完了"
  };
  const stage = task.checkpoint?.stage;
  let reply = "背景タスク: " + (labels[task.status] || task.status)
    + "\nID: " + task.task_id
    + "\n試行回数: " + task.attempts + "/" + task.max_attempts;
  if (stage) reply += "\n段階: " + (stageLabels[stage] || stage);
  if (task.updated_at) reply += "\n最終更新: " + task.updated_at + " UTC";
  const notificationLabels = { none: "対象外", pending: "通知待ち", sending: "通知中", sent: "通知済み", failed: "通知停止" };
  if (task.notify_chat_id) reply += "\n通知: " + (notificationLabels[task.notification_status] || task.notification_status);
  if (task.notification_status === "failed") reply += "\n通知停止理由: " + (task.notification_last_error_class || "delivery_failed");
  if (task.status === "failed") {
    const guidance = describeAgentTaskStopReason(task.stop_reason);
    reply += "\n停止理由: " + guidance.label
      + "\n次の操作: " + guidance.nextAction;
  }
  if (task.status === "succeeded" && typeof task.checkpoint?.result === "string") {
    reply += "\n\n" + task.checkpoint.result.slice(0, 3000);
  }
  return reply;
}
__name(getTelegramBackgroundTaskStatus, "getTelegramBackgroundTaskStatus");
async function cancelTelegramBackgroundTask(env, chatId, requestedTaskId) {
  let taskId = requestedTaskId;
  if (!taskId) {
    let active;
    try {
      active = await listAgentTasks(env.DB, { status: "active", notifyChatId: chatId, limit: 1 });
    } catch {
      return "実行中タスクを確認できませんでした。";
    }
    if (!active.length) return "キャンセルできる未完了タスクはありません。";
    taskId = active[0].task_id;
  }

  let result;
  try {
    result = await cancelAgentTask(env.DB, { taskId, chatId, nowMs: Date.now() });
  } catch {
    return "キャンセル要求を保存できませんでした。少し待って /task_status " + taskId + " で確認してください。";
  }
  if (result.cancelled) {
    // Persist cancellation first so even a failed Workflow termination cannot
    // save a result or reclaim the task. Then stop the durable execution itself.
    try {
      if (env.AGENT_TASK_WORKFLOW) {
        const instance = await env.AGENT_TASK_WORKFLOW.get(taskId);
        await instance.terminate();
      }
    } catch {
      // The D1 terminal state remains authoritative if the instance already ended.
    }
    return "キャンセルしました。\\nID: " + result.taskId
      + "\\n結果の保存・完了通知は行われません。すでに送信された外部API処理は相手側で完了する場合があります。";
  }
  if (result.reason === "already_cancelled") return "このタスクはすでにキャンセル済みです。\nID: " + taskId;
  if (result.reason === "already_terminal") return "このタスクはすでに終了しています（状態: " + result.status + "）。\nID: " + taskId;
  return "タスクが見つからないか、このチャットからキャンセルできません。\nID: " + taskId;
}
__name(cancelTelegramBackgroundTask, "cancelTelegramBackgroundTask");
async function listTelegramBackgroundTasks(env, chatId) {
  let tasks;
  try {
    tasks = await listAgentTasks(env.DB, { status: "active", notifyChatId: chatId, limit: 10 });
  } catch {
    return "背景タスク一覧を取得できませんでした。";
  }
  if (!tasks.length) return "未完了の背景タスクはありません。";

  const statusLabels = { queued: "受付済み", running: "実行中", waiting: "再試行待ち" };
  const stageLabels = {
    context_ready: "関連ノートの取得完了",
    prompt_ready: "要約プロンプトの準備完了",
    completed: "結果保存済み"
  };
  const notificationLabels = {
    none: "対象外",
    pending: "通知待ち",
    sending: "通知中",
    sent: "通知済み",
    failed: "通知停止"
  };
  const lines = tasks.map((task) => {
    const stage = task.checkpoint?.stage;
    return task.task_id
      + "\n状態: " + (statusLabels[task.status] || task.status)
      + " / 試行 " + task.attempts + "/" + task.max_attempts
      + (stage ? "\n段階: " + (stageLabels[stage] || stage) : "")
      + (task.notification_status && task.notification_status !== "none"
        ? "\n通知: " + (notificationLabels[task.notification_status] || task.notification_status) : "");
  });
  return "未完了の背景タスク（" + tasks.length + "件）:\n\n"
    + lines.join("\n\n")
    + "\n\n個別の状態・結果: /task_status タスクID";
}
__name(listTelegramBackgroundTasks, "listTelegramBackgroundTasks");
  return { getTelegramBackgroundTaskStatus, cancelTelegramBackgroundTask, listTelegramBackgroundTasks };
}
