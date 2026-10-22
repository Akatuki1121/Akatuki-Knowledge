# Background task architecture

## Chosen first executor

The interactive Worker accepts a task, persists it in D1, starts a Cloudflare Workflow, and returns a task ID immediately. Workflow execution is independent of the chat request, so the caller can continue chatting while the task runs. GitHub Actions remains the execution path for repository/code work (checks and PR preparation), not the generic runtime for conversation tasks.

- D1 is the business source of truth for task state, checkpoint, attempt count, deadlines, usage budgets and stop reasons.
- The dedicated `agent_tasks` table is separate from `yaos_sync_jobs`; the latter remains a delivery outbox for YAOS sync.
- The `/api/agent-tasks` endpoint is protected by the existing `API_TOKEN` bearer authorization. It accepts a bounded read-only knowledge query, masks identifiers before storing it, and returns a task ID; `GET /api/agent-tasks/{id}` returns status and result without echoing the original prompt. The Workflow searches relevant notes, filters unsafe excerpts, composes a prompt, calls Gemini, and saves a result checkpoint. It never creates, appends, moves, or deletes notes. Telegram has `/task <query>` to search/summarize the knowledge base and `/task_status <id>` to inspect progress/result; ordinary messages remain available while a Workflow runs.
- Cloudflare Workflows handles durable step execution and sleeping. A 15-minute recovery Cron restarts errored/terminated/finished Workflow instances only when the D1 task is still eligible. The existing hourly sync/maintenance Cron remains separate.
- Workflow IDs reuse the stable task ID. Restarting a Workflow never resets D1 attempt/usage budgets.

## State machine

`queued -> running -> waiting -> running -> succeeded`

Terminal alternatives: `failed` and `cancelled`. Lease expiry permits recovery only if the deadline and budgets still allow it. A terminal task is not automatically re-enqueued.

## Hard retry and usage limits

- Maximum attempts per task: 4 total claims.
- Backoff: 30, 60, then 120 seconds; capped at 30 minutes.
- Maximum task age: 1 hour.
- Maximum AI calls per task: 20.
- Maximum estimated AI tokens per task: 40,000.
- Daily admission cap: 60 tasks and 2,000 reserved Workflow steps (32 per task), leaving margin below the published 3,000 Workflow steps/day Free allowance. Task insertion, reservation-ledger insertion, daily counter increment, and `budget_reserved` admission flag are applied in one D1 batch. A task-keyed unique ledger and `counted` marker prevent retries from charging twice. Reservations are conservative and are not refunded if dispatch fails.
- Only explicit transient classes are retryable: network error, timeout, rate limit, upstream 5xx, executor interruption.
- Unknown errors stop. Authentication/authorization, invalid input, credential detection, PII masking failures and policy errors stop immediately.
- AI call and estimated-token budget is reserved atomically before the provider call; a failed provider call still consumes the reservation.
- Raw exception messages are not persisted. Only classified error codes are stored.

## Safety invariants

- Inspect AI-bound content immediately before the provider call. Credential detection blocks the call.
- Redact direct identifiers such as email, phone, address and account/card identifiers before sending.
- Health/financial/location-sensitive content that the current redactor cannot safely mask is blocked rather than sent unredacted.
- No `ai_allowed` switch or per-operation AI permission gate is added.
- The API endpoint is authenticated and bounds request size, prompt length and output tokens.

## Cloudflare Free-plan constraints checked 2026-10-20

Official docs:
- Workflows pricing: https://developers.cloudflare.com/workflows/reference/pricing/
- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/

Published Free allowances include 3,000 Workflow steps/day, 100,000 Workflow executions/day shared with Workers request limits, 100 active concurrent Workflow instances, 10 ms CPU per step, 1 MiB per non-stream step result, 100 MB maximum persisted state per instance, 1 GB-month of included Workflow state storage, and 3-day Workflow state retention. Workflow steps can wait on network I/O without consuming CPU during the wait. The design keeps steps small, caps task execution and output size, and uses D1 as durable business state. The recovery Cron handles at most five tasks per run to limit CPU and subrequests.

## Current task-type boundary

The first task type is `knowledge_query`: a read-only multi-stage note search and summarization. Note writes are intentionally excluded until their D1/YAOS side effects have explicit idempotency keys, operation-bound approvals, and restart tests. The Workflow stores `context_ready`, `prompt_ready`, `agent_loop`, and `completed` checkpoints; a restart reuses saved context/prompt, replays only a pending read-only tool action, and completes from an existing output rather than issuing another AI call.

## Issue 35 operation inventory

| Operation | Entry point | Side effects | Background status |
| --- | --- | --- | --- |
| Search and summarize approved notes | Telegram `/task <query>` or authenticated `POST /api/agent-tasks` | Reads D1 notes; calls Gemini after privacy checks; stores task checkpoints/result in D1; Telegram tasks send a terminal notification | Enabled as `knowledge_query`; read-only with respect to notes |
| Search notes from an agent step | Internal `search_notes` allowlisted tool | Reads only AI-approved, credential-screened notes and returns masked, bounded excerpts | Enabled; at most four tool calls and five model calls per Workflow run |
| Read a search result | Internal `get_note` allowlisted tool | Returns one bounded result previously returned by `search_notes`; no new access outside the task's retrieved result set | Enabled |
| Inspect one task | Telegram `/task_status <id>` or authenticated `GET /api/agent-tasks/{id}` | Reads task metadata/checkpoint/result; no note or AI side effect | Enabled |
| List tasks | Telegram `/tasks` or authenticated `GET /api/agent-tasks?status=...` | Reads bounded task metadata; no note or AI side effect | Enabled |
| Create, append, correct, move, archive, or restore a note | Existing synchronous note/API flows | Mutates D1 and may enqueue a YAOS outbox delivery | Not connected to the generic background Workflow |

The generic Workflow must reject every task type except `knowledge_query`. Its tool allowlist is read-only and schemas reject unknown tools, extra arguments, and malformed responses. In particular, note mutations, external messages and deletion are not background tools and have no approval-bypass path. Keep them disabled until a separate design specifies operation-bound approvals, before-state checks and idempotent side-effect keys.

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

Authenticated `GET /api/agent-tasks?status=active` lists queued, running, and waiting tasks without returning their original prompts. Use `status=terminal` or `status=all` for a bounded audit of task state. Telegram `/tasks` lists the current chat's unfinished tasks, so task IDs and checkpoint stages remain discoverable even if the original conversation is no longer available. Individual results remain available through `/task_status <id>` or `GET /api/agent-tasks/{id}`.
