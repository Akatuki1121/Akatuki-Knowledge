# Background task architecture

予算制御の調査・段階移行・自己監査の計画は [BACKGROUND_TASK_BUDGET_ROADMAP.md](BACKGROUND_TASK_BUDGET_ROADMAP.md) を参照。

> 2026-10-26 の縮小で Telegram の入口 (`/task`、`/research`、`/task_status`、`/cancel`、`/github` コマンドと GitHub 変更計画のチャット承認) と、完了通知の Telegram 送信は廃止した。タスクの受付は `POST /api/agent-tasks` のみで、結果は `GET /api/agent-tasks` で取得する。本文書のうち Telegram に言及する部分は廃止時点の設計記録として残す。

## Chosen first executor

The interactive Worker accepts a task, persists it in D1, starts a Cloudflare Workflow, and returns a task ID immediately. Workflow execution is independent of the chat request, so the caller can continue chatting while the task runs. GitHub Actions remains the execution path for repository/code work (checks and PR preparation), not the generic runtime for conversation tasks.

- D1 is the business source of truth for task state, checkpoint, attempt count, deadlines, usage budgets and stop reasons.
- The dedicated `agent_tasks` table is separate from `yaos_sync_jobs`; the latter remains a delivery outbox for YAOS sync.
- The `/api/agent-tasks` endpoint is protected by the existing `API_TOKEN` bearer authorization. It accepts a bounded read-only knowledge query, masks identifiers before storing it, and returns a task ID; `GET /api/agent-tasks/{id}` returns status and result without echoing the original prompt. The Workflow searches relevant notes, filters unsafe excerpts, composes a prompt, calls Gemini, and saves a result checkpoint. It never creates, appends, moves, or deletes notes. Telegram has `/task <query>` to search/summarize the knowledge base, `/research <query>` for explicitly opted-in web research, `/task_status <id>` to inspect progress/result, and `/cancel [task_id]` to cancel an active task (without an ID it targets the most recently updated active task in that chat); ordinary messages remain available while a Workflow runs. Cancellation atomically marks the task terminal, clears its lease, suppresses the worker's terminal notification, prevents later checkpoint/completion writes, and calls Cloudflare Workflows `terminate()` for the matching instance. If termination fails because the instance already ended or the binding is unavailable, the D1 terminal state still prevents recovery and result delivery. An external provider may still finish processing a request that was already sent.
- Cloudflare Workflows handles durable step execution and sleeping. A 15-minute recovery Cron restarts errored/terminated/finished Workflow instances only when the D1 task is still eligible. The existing hourly sync/maintenance Cron remains separate.
- Workflow IDs reuse the stable task ID. Restarting a Workflow never resets D1 attempt/usage budgets.

## State machine

`queued -> running -> waiting -> running -> succeeded`

Terminal alternatives: `failed` and `cancelled`. Lease expiry permits recovery only if the deadline and budgets still allow it. A terminal task is not automatically re-enqueued.

## Retry, quota, and execution limits

- 通常タスク: 一時障害時は最大4回のclaim、最大経過時間1時間、backoff 30秒→60秒→120秒（最大30分）。
- 改善タスク: 一時障害時は最大4回の実試行（初回＋再試行3回）、待機1時間→3時間→3時間、通常の最大経過時間8時間。これらは外部障害時の再試行制御であり、Workers AIの呼び出し回数・トークン数の上限ではない。
- Workers AIの独自Neurons上限、タスク別AI呼び出し回数、タスク別AI token上限、1回あたり1,024 token出力上限は撤去した。GLM-4.7-Flashの131,072 token context windowを基準に、入力見積もりを差し引いた範囲で出力を要求する。CloudflareのFree枠10,000 Neurons/日が実際の利用上限であり、アカウント全体の消費をCloudflare側が判定する。
- `workers_ai_daily_usage` と `agent_tasks.ai_calls_used/ai_tokens_used` は計測用。台帳テーブルが未作成・未適用でもAI呼び出しを止めない。予約値・実usageが取得できない場合は監査上のtelemetry欠落として記録し、Cloudflareのクォータ判定を代替しない。
- Workers AIの日次枠到達は `workers_ai_daily_quota_exhausted` として分類し、UTC 00:01まで待機する。これは通常の再試行回数を消費せず、タスク期限も次回実行可能時刻の1時間後まで延長する。枠のリセット後に自動再開する。
- その他の一時障害として再試行するのは network error、timeout、429/rate limit、upstream 5xx、executor interruption。認証・権限、入力不正、認証情報検出、PII masking、policy違反などは再試行しない。未知のエラーも安全側で停止する。
- 改善依頼が失敗・キャンセルした場合、同じ本文のまま自動で新規タスクを作らない。内容を編集するとcontent hash/idempotency keyが変わり、新しい試行として受け付ける。失敗結果は改善ノートへ追記せず、成功結果だけを書き戻す。
- AI使用量の予約・精算はbest-effort telemetry。provider usageが返れば実Neuronsを記録し、応答なしの失敗は入力推定分を記録する。usageがない成功応答は過少計上防止のため予約を残す。いずれもAI呼び出しの許可/拒否には使わない。
- 日次Workflow予約は32 steps/タスク、最大2,700 reserved steps/UTC日。これはWorkflows Free枠3,000 steps/日の別資源ゲートであり、Workers AIのNeurons枠とは独立している。旧60件/日制限は撤去済み。予約台帳は失敗時に実消費step数へ精算する段階移行が未完了。
- Agent tool loopにモデル呼び出し回数・ツール呼び出し回数の独自上限は設けない。同じ不正な書込計画の反復、同一tool callの反復、モデルcontext window、Workflow/D1の実クォータ、tool結果payloadサイズは安全・実行環境上の制約として残す。
- Raw exception messages are not persisted. Only classified error codes are stored.

## Daily self-audit and automatic improvement

- Worker Cron `55 23 * * *` (UTC) runs a deterministic daily audit of task outcomes, repeated error classes, Workflow reservations, and Workers AI usage telemetry.
- Each day it creates `Notes/改善/自己監査-YYYY-MM-DD.md` with `origin: budget-audit` and `audit_generated: true`. The note asks the existing improvement agent to inspect the repository, CI, migrations, quotas, failure recovery, and deployment boundaries. It does not create a second executor or recursively schedule another audit.
- The hourly vault sync/improvement-inbox pipeline picks up the note and performs the repository audit. If a justified change is found, the existing executor creates a branch, applies changes, runs required CI, opens a PR, and requests squash auto-merge. If no change is justified, it records the findings without creating an empty PR.
- `GET /api/budget-audit` (API_TOKEN protected) returns the latest stored audit reports.
- The improvement inbox scans in 30-note pages with a persistent keyset cursor, so a large backlog does not permanently starve notes after the first page.
- Self-improvement may modify `src/`, `scripts/`, `tests/`, `docs/`, `schema-snapshots/`, `migrations/pending/`, and approved root configuration files. It may create new read-only workflows, but cannot modify the protected `auto-merge.yml`, `check.yml`, or `deploy.yml`, and cannot write directly to applied migration history.
- Existing-file changes can use unified-diff `apply_patch` with a blob-SHA precondition. This avoids requiring the model to reproduce an entire large source file just to change a few lines.
- `.github/workflows/auto-merge.yml` follows Purge's `pull_request_target` + `gh pr merge --auto --squash` pattern for owner and known Dependabot PRs. Self-generated PRs also request auto-merge through the executor. No path bypasses required checks or branch protection.
- Pending D1 migrations remain a deployment gate. The audit and AI request path do not apply production migrations or deploy a Worker.

## Safety invariants

- Inspect AI-bound content immediately before the provider call. Credential detection blocks the call.
- Agent tool-loop calls request Workers AI JSON output explicitly and validate the returned action shape before running any tool or accepting a result.
- Redact direct identifiers such as email, phone, address and account/card identifiers before sending.
- Health/financial/location-sensitive content that the current redactor cannot safely mask is blocked rather than sent unredacted.
- No `ai_allowed` switch or per-operation AI permission gate is added.
- The API endpoint is authenticated and bounds request size to the provider/model context and transport payload constraints, not to an arbitrary task token budget.

## Cloudflare Free-plan constraints checked 2026-10-30

Official docs (quotas reset at 00:00 UTC where applicable):
- Workers: 100,000 requests/day; Workflow executions share this request quota.
- D1: 5 million rows read/day and 100,000 rows written/day.
- Durable Objects: 100,000 requests/day and 13,000 GB-s/day.
- Workers AI: 10,000 Neurons/day.
- Workflows: 100,000 executions/day shared with Workers and 3,000 steps/day.

References:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

Seven-day account-level GraphQL Analytics observations and the staged budget redesign are documented in [BACKGROUND_TASK_BUDGET_ROADMAP.md](BACKGROUND_TASK_BUDGET_ROADMAP.md). The observations are account-wide and must not be interpreted as Akatuki-only consumption where the dataset has no worker-level attribution. GraphQL Analytics runtime ingestion is not connected to this Worker yet; it requires an owner-issued read-only Account Analytics token.

## Current task-type boundary

The generic task type is `knowledge_query`: a read-only multi-stage note search and summarization. `github_query` supports repository inspection and structured write plans; `improvementRequest` tasks can execute the validated plan automatically and create a PR. A `github_query` task is available through authenticated API requests or the improvement-note pipeline when the request clearly targets GitHub/Issue/PR/repository/CI work. It uses a GitHub-only prompt and GET-only read tools for issues, pull requests, latest PR check-run statuses, and bounded public text files; unrelated personal notes are not injected. If a change is needed, the model creates a structured plan. Ordinary `github_query` tasks remain proposal-only; improvement-note tasks with `improvementRequest: true` may execute only the validated, hash-bound plan. Supported operations include branch creation, file creation/update, unified-diff application, issue creation/comment, and PR creation. Merge/release/deploy/delete/permission changes are not part of the plan. The executor requests squash auto-merge; GitHub required checks and branch protection remain the final gate. The Worker requires a `GITHUB_TOKEN` secret with the minimum Contents/Issues/Pull requests permissions to execute approvals; read-only public access does not require it. Merge, release, deployment, deletion, and permission changes are not supported by this write plan. The proposal tool definition discloses each operation type's required keys so the model can meet the strict plan validator. A proposal whose shape fails validation is not saved or executed; the loop returns a fixed validation error (reason code `write_plan_shape`, without the rejected plan) to the model so it can re-propose within the model-call budget, and if the budget runs out the task fails with `invalid_input:write_plan_shape`. Note writes are intentionally excluded until their D1/YAOS side effects have explicit idempotency keys, operation-bound approvals, and restart tests. The Workflow stores `context_ready`, `prompt_ready`, `agent_loop`, and `completed` checkpoints; a restart reuses saved context/prompt, replays only a pending safe read action, and completes from an existing output rather than issuing another AI call.

Web research is a separate explicit opt-in on `/research <query>` or authenticated `POST /api/agent-tasks` with `"allowWebResearch": true`; ordinary `/task` requests cannot use it. The Worker must also have `GEMINI_WEB_RESEARCH_ENABLED=true`. That switch is intentionally absent from the default Wrangler config: Google Search grounding is unavailable on Gemini's Free tier. The pricing page lists a shared allowance of 5,000 grounding requests per month for Gemini 3+ Paid tier, then $14 per 1,000 requests (checked 2026-10-22); an interaction can issue multiple provider-side queries, so each interaction strictly caps search queries (`maxSearchQueriesPerCall: 4`) and interactions per task (`maxCalls: 2`) to prevent unbounded provider queries. Google's terms say Unpaid Services may use prompts and responses to improve products and allow human review, while Paid Services do not use prompts/responses for product improvement but may retain limited safety logs. `store: false` only opts out of Interactions API storage; it does not change the account's paid/unpaid data-use terms. Confirm the Cloud Project billing state and terms before enabling web research. Requests require both Google Search and URL Context evidence, screen outgoing queries and returned text, and treat page instructions as untrusted. At most two interactions are allowed per task; each reserves at least 13,200 estimated AI tokens before contacting the provider, and only three cited sources are returned in the final Telegram message. Account-level request/cost monitoring remains part of #42. Gemini Search, URL Context, pricing, and terms documentation were checked on 2026-10-22.

The deterministic agent safety evaluation set runs as part of `npm run check` (`scripts/test_agent_evaluation_set.mjs`). It uses synthetic note and provider responses only; it makes no external requests and checks instruction-injection boundaries, citation filtering, denied side effects, evidence requirements, memory trust derivation, and retry fail-closed behavior. This complements the lower-level contract tests; it does not measure model answer quality or account-level provider usage.

## Issue 35 operation inventory

| Operation | Entry point | Side effects | Background status |
| --- | --- | --- | --- |
| Search and summarize approved notes | Telegram `/task <query>` or authenticated `POST /api/agent-tasks` | Reads D1 notes; calls Gemini after privacy checks; stores task checkpoints/result in D1; Telegram tasks send a terminal notification | Enabled as `knowledge_query`; read-only with respect to notes |
| Inspect GitHub and propose approved writes | Telegram natural language or `/github <request>`; approve with `/github approve <task_id>` or reject with `/github reject <task_id>` | Reads are GET-only; write plans are stored in the task checkpoint and hashed; only the explicit approval handler executes the allowlisted write operations | `github_query`; writes require a valid plan, same-chat approval, unexpired status, and `GITHUB_TOKEN`; merge/deploy/delete/permission changes excluded |
| Search notes from an agent step | Internal `search_notes` allowlisted tool | Reads only AI-approved, credential-screened notes and returns masked, bounded excerpts | Enabled; without application-specific model-call or tool-call count caps; repeated identical calls are rejected and Cloudflare Workflow quotas remain authoritative |
| Read a search result | Internal `get_note` allowlisted tool | Returns one bounded result previously returned by `search_notes`; no new access outside the task's retrieved result set | Enabled |
| Search and inspect public web pages | Explicit `/research` task or authenticated API opt-in; internal `web_research` tool | Uses Gemini Google Search grounding and URL Context; stores bounded report, cited URL/title/evidence, and retrieval timestamp in the task checkpoint | Disabled unless `GEMINI_WEB_RESEARCH_ENABLED=true`; at most two provider interactions per task, capped at 4 search queries per interaction |
| Inspect one task | Telegram `/task_status <id>` or authenticated `GET /api/agent-tasks/{id}` | Reads task metadata/checkpoint/result; no note or AI side effect | Enabled |
| List tasks | Telegram `/tasks` or authenticated `GET /api/agent-tasks?status=...` | Reads bounded task metadata; no note or AI side effect | Enabled |
| Create, append, correct, move, archive, or restore a note | Existing synchronous note/API flows | Mutates D1 and may enqueue a YAOS outbox delivery | Not connected to the generic background Workflow |

The generic Workflow accepts only `knowledge_query` and `github_query`; the latter requires server-created read permission and can enable proposal-only write planning. Telegram cannot submit arbitrary API endpoints or execute writes directly. Actual writes are dispatched only by the separate same-chat approval handler after plan hash, expiry, and one-time claim checks. Its tool allowlist is read-only for notes; external web research is separately permission-gated and cost-bounded. Schemas reject unknown tools, extra arguments, and malformed responses. In particular, note mutations, external messages and deletion are not background tools and have no approval-bypass path. Keep them disabled until a separate design specifies operation-bound approvals, before-state checks and idempotent side-effect keys.

For the enabled query, the durable stages are `context_ready` (filtered note IDs and excerpts), `prompt_ready` (privacy-inspected assembled prompt and reserved estimate), `agent_loop` (bounded transcript, tool arguments/results and any pending action), and `completed` (bounded answer and cited IDs). Every model request is screened before sending and checked against the model context window; every response is checked before parsing. AI usage counters are telemetry only. Tool results are treated as untrusted reference data. Repeated tool signatures, invalid/unknown tools, oversize results, step exhaustion, and budget exhaustion stop closed. The sanitized task payload also stores a SHA-256 input hash. Reusing an idempotency key with the same input returns the existing task without another reservation; reusing it with different input is rejected. A retry reuses the earliest valid checkpoint and must not repeat a completed task. An expired lease may be claimed by one executor; the previous lease token can no longer save a checkpoint or complete the task. Deadline and budget exhaustion are terminal and retain the checkpoint for diagnosis.

## Implementation / rollout boundary

- Retry policy, pending D1 schema, claim/lease/checkpoint store, and Workflow/API wiring are developed on a feature branch and validated with Actions.
- `migrations/0011_agent_tasks.sql` is recorded in the production ledger (applied 2026-10-21) and the live schema matched it on 2026-10-22.
- No production D1 migration, Worker deployment, secret change, or live note mutation is performed by this PR.
- Schema rollout is done; before enabling more task types, run an authenticated smoke test and document rollback.


## Terminal notification and recovery

Telegram-originated tasks persist their notification target and delivery state in D1. The Workflow sends a terminal result immediately; the 15-minute recovery Cron also scans terminal tasks whose notification is pending or whose sending lease expired. Delivery retries use bounded exponential backoff and stop after eight attempts. A notification failure never re-runs the AI task or resets its execution budget. HTTP-created tasks without a Telegram target do not send Telegram messages.

`/task_status <id>` and the authenticated status API expose notification delivery separately from task execution. A task can be complete while its notification is pending; the recovery path handles that state without repeating the task.


## Discovering unfinished work

Authenticated `GET /api/agent-tasks?status=active` lists queued, running, and waiting tasks without returning their original prompts. Use `status=terminal` or `status=all` for a bounded audit of task state. Telegram `/tasks` lists the current chat's unfinished tasks, so task IDs and checkpoint stages remain discoverable even if the original conversation is no longer available. Send `/cancel` to stop the latest active task in that chat, or `/cancel <task_id>` to target a specific task. Individual results remain available through `/task_status <id>` or `GET /api/agent-tasks/{id}`.


## 改善フォルダからの自動 GitHub 作業

毎時の定期処理は、Vault pull が成功した後に `Notes/改善/` 配下の生存 D1 ノートを走査します。`このフォルダについて.md` は対象外です。起票の冪等キーはノートの `sync_uuid` と `content_hash` から生成し、処理済みハッシュは `app_meta` に記録します。結果追記後に変わったハッシュも処理済みとして記録するため、エージェント自身の結果追記で再起票されません。依頼本文が変われば新しいハッシュとして再評価されます。

Workers AI のモデルは `@cf/meta/llama-3.1-8b-instruct` です。出力上限は 1024 tokens、既存の tool loop は最大 5 モデル呼び出し/タスク、改善依頼は最大 3 タスク/日です。Workers AI の無料枠はアカウントや時点で変わりうるため、この上限は無制限利用を防ぐ運用上のガードであり、無料利用を保証するものではありません。

自動実行は計画ハッシュを再計算し、保存された計画と一致する場合だけ許可します。操作はブランチ作成、`src/`・`scripts/`・`docs/` 内のファイル作成/更新、最後の PR 作成に限定されます。`.github/workflows/`、`migrations/`、その他のパス、Issue・コメント、削除、権限変更、リリース、デプロイは対象外です。範囲外の計画は PR 作成前に停止し、理由を元ノートへ追記します。範囲内の PR は squash 自動マージを要求し、GitHub の必須チェックが成功するまでマージを待機します。

処理結果（PR URL、自動マージの有効化状態、停止理由、失敗コード）は元ノートへ通常の correction API と同期 outbox 経由で追記されます。Web 調査は本経路では利用できず、一般の `POST /api/agent-tasks` からの Web 調査指定も拒否します。
