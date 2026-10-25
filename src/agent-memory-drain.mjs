// 記憶キューの drain (claim/完了/失敗分類) (Issue #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。キューの読み書きは src/agent-memory-queue.mjs から直接 import し、
// describeSafeFailure は src/log-sanitize.mjs から直接 import する (organize.mjs の前例)。
// 処理本体 processAgentMemoryJob は AI 送信ガードの検査や #91 の計測と結びつくため
// index.js 側に残し、呼び出し側から同名で注入する。再試行ポリシー (retryable 判定と
// errorClass 分類) はこの関数の意味論そのものであり、抽出では変更していない。
// Worker エントリポイントには依存しない。
import { claimNextAgentMemoryJob, completeAgentMemoryJob, failAgentMemoryJob } from "./agent-memory-queue.mjs";
import { describeSafeFailure } from "./log-sanitize.mjs";

// src/index.js のバンドル由来のヘルパー。移動した関数の __name 注釈が使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// 記憶キューの drain を組み立てる。本文は移動前と同一。
export function createAgentMemoryDrain({ processAgentMemoryJob }) {
async function drainAgentMemoryQueue(env, requestedLimit = 1) {
  if (!env?.DB || !env.GEMINI_API_KEY) return;
  const limit = Math.max(1, Math.min(2, Number(requestedLimit) || 1));
  for (let i = 0; i < limit; i++) {
    let job;
    try {
      job = await claimNextAgentMemoryJob(env.DB);
    } catch (error) {
      console.error("agent memory queue claim failed", JSON.stringify(describeSafeFailure("agent_memory_queue_claim_failed", error)));
      return;
    }
    if (!job) return;
    try {
      await processAgentMemoryJob(env, job);
      await completeAgentMemoryJob(env.DB, Number(job.job_id));
    } catch (error) {
      const status = Number(error?.httpStatus || 0);
      const retryable = status === 429 || status >= 500 || error?.name === "AbortError"
        || error?.name === "TimeoutError" || error instanceof TypeError;
      const errorClass = status === 429 ? "gemini_limit"
        : status >= 500 ? "gemini_server_error"
          : error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout"
            : error instanceof TypeError ? "network_error" : "memory_processing_failed";
      try {
        await failAgentMemoryJob(env.DB, Number(job.job_id), { retryable, errorClass });
      } catch (updateError) {
        console.error("agent memory job state update failed", JSON.stringify(describeSafeFailure("agent_memory_job_state_update_failed", updateError)));
        return;
      }
      console.error("agent memory job failed", JSON.stringify(describeSafeFailure("agent_memory_job_failed", error)));
    }
  }
}
__name(drainAgentMemoryQueue, "drainAgentMemoryQueue");
  return { drainAgentMemoryQueue };
}
