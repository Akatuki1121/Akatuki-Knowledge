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

## Hard retry and usage limits

- 通常タスク: 最大4回のclaim、最大経過時間1時間、backoff 30秒→60秒→120秒（最大30分）。
- 改善タスク: 最大4試行（初回＋一時障害時の再試行3回）、待機1時間→3時間→3時間、最大経過時間8時間。Workflow step内の再試行もAI呼び出し回数に含める。
- AI呼び出し上限: 通常タスク20回、改善タスク5回。トークン上限: 通常タスク40,000、改善タスク12,000。改善タスクの1回あたり最大出力は1,024 tokens。
- 一時障害として再試行するのは network error、timeout、429/rate limit、upstream 5xx、executor interruption。認証・権限、入力不正、認証情報検出、PII masking、policy違反などは再試行しない。未知のエラーも安全側で停止する。
- 改善依頼が失敗・キャンセルした場合、同じ本文のまま自動で新規タスクを作らない。内容を編集するとcontent hash/idempotency keyが変わり、新しい試行として受け付ける。失敗結果は改善ノートへ追記せず、成功結果だけを書き戻す。
- AI呼び出し前にNeuronsとタスク別tokenを予約する。成功時にprovider usageが返れば実トークンから精算する。応答なしの失敗は入力token推定分だけを実消費として計上し、出力予約を戻す。usageがない成功応答は過少計上防止のため予約を残す。呼び出し回数は返金しない。
- 日次Workflow予約は32 steps/タスク、最大2,700 reserved steps/UTC日。旧60件/日制限は撤去済み。Workers AIの日次予約上限は8,000 Neurons（無料枠10,000の80%）。この2つは現在のアプリ側ゲートであり、アカウント全体の全資源を測る完全な消費量制御ではない。
- Workflow step予約はまだタスク単位の固定見積もりで、失敗時に実際に使わなかったstep分を精算していない。Workers/D1/DO/YAOSの共有利用量やGraphQL Analyticsとの照合も未実装。これらは影子運用の別PRで扱う。
- Raw exception messages are not persisted. Only classified error codes are stored.

## Safety invariants

- Inspect AI-bound content immediately before the provider call. Credential detection blocks the call.
- Agent tool-loop calls request Gemini JSON output explicitly and validate the returned action shape before running any tool or accepting a result.
- Redact direct identifiers such as email, phone, address and account/card identifiers before sending.
- Health/financial/location-sensitive content that the current redactor cannot safely mask is blocked rather than sent unredacted.
- No `ai_allowed` switch or per-operation AI permission gate is added.
- The API endpoint is authenticated and bounds request size, prompt length and output tokens.

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

The first task type is `knowledge_query`: a read-only multi-stage note search and summarization. A `github_query` task is available through Telegram `/github <request>` or natural-language requests that clearly mention GitHub/Issue/PR/repository/CI work plus an action. It uses a GitHub-only prompt and GET-only read tools for issues, pull requests, latest PR check-run statuses, and bounded public text files; unrelated personal notes are not injected. If a change is needed, the model may create a structured proposal only: branch creation, file create/update, issue creation, issue comment, and PR creation are represented as an ordered plan. No write happens until the same Telegram chat explicitly sends `/github approve <task_id>`. `/github reject <task_id>` rejects a pending plan. The complete normalized plan is hash-bound, stored in the completed task checkpoint, displayed in Telegram in bounded chunks, expires after 24 hours, and is atomically claimed once to prevent duplicate execution. The Worker requires a `GITHUB_TOKEN` secret with the minimum Contents/Issues/Pull requests permissions to execute approvals; read-only public access does not require it. Merge, release, deployment, deletion, and permission changes are not supported by this write plan. The proposal tool definition discloses each operation type's required keys so the model can meet the strict plan validator. A proposal whose shape fails validation is not saved or executed; the loop returns a fixed validation error (reason code `write_plan_shape`, without the rejected plan) to the model so it can re-propose within the model-call budget, and if the budget runs out the task fails with `invalid_input:write_plan_shape`. Note writes are intentionally excluded until their D1/YAOS side effects have explicit idempotency keys, operation-bound approvals, and restart tests. The Workflow stores `context_ready`, `prompt_ready`, `agent_loop`, and `completed` checkpoints; a restart reuses saved context/prompt, replays only a pending safe read action, and completes from an existing output rather than issuing another AI call.

Web research is a separate explicit opt-in on `/research <query>` or authenticated `POST /api/agent-tasks` with `"allowWebResearch": true`; ordinary `/task` requests cannot use it. The Worker must also have `GEMINI_WEB_RESEARCH_ENABLED=true`. That switch is intentionally absent from the default Wrangler config: Google Search grounding is unavailable on Gemini's Free tier. The pricing page lists a shared allowance of 5,000 grounding requests per month for Gemini 3+ Paid tier, then $14 per 1,000 requests (checked 2026-10-22); an interaction can issue multiple provider-side queries, so each interaction strictly caps search queries (`maxSearchQueriesPerCall: 4`) and interactions per task (`maxCalls: 2`) to prevent unbounded provider queries. Google's terms say Unpaid Services may use prompts and responses to improve products and allow human review, while Paid Services do not use prompts/responses for product improvement but may retain limited safety logs. `store: false` only opts out of Interactions API storage; it does not change the account's paid/unpaid data-use terms. Confirm the Cloud Project billing state and terms before enabling web research. Requests require both Google Search and URL Context evidence, screen outgoing queries and returned text, and treat page instructions as untrusted. At most two interactions are allowed per task; each reserves at least 13,200 estimated AI tokens before contacting the provider, and only three cited sources are returned in the final Telegram message. Account-level request/cost monitoring remains part of #42. Gemini Search, URL Context, pricing, and terms documentation were checked on 2026-10-22.

The deterministic agent safety evaluation set runs as part of `npm run check` (`scripts/test_agent_evaluation_set.mjs`). It uses synthetic note and provider responses only; it makes no external requests and checks instruction-injection boundaries, citation filtering, denied side effects, evidence requirements, memory trust derivation, and retry fail-closed behavior. This complements the lower-level contract tests; it does not measure model answer quality or account-level provider usage.

## Issue 35 operation inventory

| Operation | Entry point | Side effects | Background status |
| --- | --- | --- | --- |
| Search and summarize approved notes | Telegram `/task <query>` or authenticated `POST /api/agent-tasks` | Reads D1 notes; calls Gemini after privacy checks; stores task checkpoints/result in D1; Telegram tasks send a terminal notification | Enabled as `knowledge_query`; read-only with respect to notes |
| Inspect GitHub and propose approved writes | Telegram natural language or `/github <request>`; approve with `/github approve <task_id>` or reject with `/github reject <task_id>` | Reads are GET-only; write plans are stored in the task checkpoint and hashed; only the explicit approval handler executes the allowlisted write operations | `github_query`; writes require a valid plan, same-chat approval, unexpired status, and `GITHUB_TOKEN`; merge/deploy/delete/permission changes excluded |
| Search notes from an agent step | Internal `search_notes` allowlisted tool | Reads only AI-approved, credential-screened notes and returns masked, bounded excerpts | Enabled; at most four tool calls and five model calls per Workflow run |
| Read a search result | Internal `get_note` allowlisted tool | Returns one bounded result previously returned by `search_notes`; no new access outside the task's retrieved result set | Enabled |
| Search and inspect public web pages | Explicit `/research` task or authenticated API opt-in; internal `web_research` tool | Uses Gemini Google Search grounding and URL Context; stores bounded report, cited URL/title/evidence, and retrieval timestamp in the task checkpoint | Disabled unless `GEMINI_WEB_RESEARCH_ENABLED=true`; at most two provider interactions per task, capped at 4 search queries per interaction |
| Inspect one task | Telegram `/task_status <id>` or authenticated `GET /api/agent-tasks/{id}` | Reads task metadata/checkpoint/result; no note or AI side effect | Enabled |
| List tasks | Telegram `/tasks` or authenticated `GET /api/agent-tasks?status=...` | Reads bounded task metadata; no note or AI side effect | Enabled |
| Create, append, correct, move, archive, or restore a note | Existing synchronous note/API flows | Mutates D1 and may enqueue a YAOS outbox delivery | Not connected to the generic background Workflow |

The generic Workflow accepts only `knowledge_query` and `github_query`; the latter requires server-created read permission and can enable proposal-only write planning. Telegram cannot submit arbitrary API endpoints or execute writes directly. Actual writes are dispatched only by the separate same-chat approval handler after plan hash, expiry, and one-time claim checks. Its tool allowlist is read-only for notes; external web research is separately permission-gated and cost-bounded. Schemas reject unknown tools, extra arguments, and malformed responses. In particular, note mutations, external messages and deletion are not background tools and have no approval-bypass path. Keep them disabled until a separate design specifies operation-bound approvals, before-state checks and idempotent side-effect keys.

For the enabled query, the durable stages are `context_ready` (filtered note IDs and excerpts), `prompt_ready` (privacy-inspected assembled prompt and reserved estimate), `agent_loop` (bounded transcript, tool arguments/results and any pending action), and `completed` (bounded answer and cited IDs). Every model request is screened before sending; every response is checked before parsing; each model call reserves task AI/token budget. Tool results are treated as untrusted reference data. Repeated tool signatures, invalid/unknown tools, oversize results, step exhaustion, and budget exhaustion stop closed. The sanitized task payload also stores a SHA-256 input hash. Reusing an idempotency key with the same input returns the existing task without another reservation; reusing it with different input is rejected. A retry reuses the earliest valid checkpoint and must not repeat a completed task. An expired lease may be claimed by one executor; the previous lease token can no longer save a checkpoint or complete the task. Deadline and budget exhaustion are terminal and retain the checkpoint for diagnosis.

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


## Budget self-audit

A read-only operational self-audit runs twice daily (00:00 and 12:00 UTC). Retrieve recent reports with authenticated `GET /api/budget-audit`. It checks recent task failures, repeated error classes, reserved Workflow steps, and Workers AI usage when its ledger exists. It makes no model calls and does not write notes or modify code.
