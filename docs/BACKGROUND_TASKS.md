# Background task architecture

## Chosen first executor

The interactive Worker accepts a task, persists it in D1, starts a Cloudflare Workflow, and returns a task ID immediately. Workflow execution is independent of the chat request, so the caller can continue chatting while the task runs. GitHub Actions remains the execution path for repository/code work (checks and PR preparation), not the generic runtime for conversation tasks.

- D1 is the business source of truth for task state, checkpoint, attempt count, deadlines, usage budgets and stop reasons.
- The dedicated `agent_tasks` table is separate from `yaos_sync_jobs`; the latter remains a delivery outbox for YAOS sync.
- The `/api/agent-tasks` endpoint is protected by the existing `API_TOKEN` bearer authorization. It accepts a bounded AI-prompt task, masks identifiers before storing it, and returns a task ID; `GET /api/agent-tasks/{id}` returns status and result without echoing the original prompt. The Workflow repeats the safety check immediately before calling Gemini. Telegram has `/task <prompt>` to enqueue and `/task_status <id>` to inspect progress/result; ordinary messages remain available while a Workflow runs.
- Cloudflare Workflows handles durable step execution and sleeping. A 15-minute recovery Cron restarts errored/terminated/finished Workflow instances only when the D1 task is still eligible. Intake requests never restart an existing stopped Workflow; only the scheduled recovery path may do so, preventing repeated webhook/API delivery from triggering an immediate restart loop. Task lifetime and persisted attempt/usage budgets remain hard stop conditions. The existing hourly sync/maintenance Cron remains separate.
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

## Implementation / rollout boundary

- Retry policy, pending D1 schema, claim/lease/checkpoint store, and Workflow/API wiring are developed on a feature branch and validated with Actions.
- `migrations/pending/0011_agent_tasks.sql` is not applied to production.
- No production D1 migration, Worker deployment, secret change, or live note mutation is performed by this PR.
- Before production rollout, review the pending migration chain, apply the migration explicitly, run an authenticated smoke test, and document rollback.


## Terminal notification and recovery

Telegram-originated tasks store their notification target and delivery state in the same D1 task row. The Workflow attempts notification immediately after a terminal result; the 15-minute recovery Cron also scans terminal tasks whose notification is still pending or whose sending lease expired. Delivery retries use bounded exponential backoff and stop after eight attempts. A notification failure never re-runs the AI task, changes its task result, or resets its execution budget. HTTP-created tasks without a Telegram target do not send Telegram messages.

Use `/task_status <id>` or the authenticated task-status API to inspect both task execution and notification delivery. A task may be complete even while its notification is pending; those are separate states.
