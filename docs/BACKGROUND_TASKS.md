# Background task architecture (Issue #29)

## Decision in progress

The interactive Worker must acknowledge task intake quickly and must not perform a long agent task inside the chat request. A persistent task record is the business source of truth; the executor is replaceable.

- Intake: authenticated chat/API request validates and enqueues a task, then returns its stable task ID.
- State of record: a dedicated D1 table for agent tasks, separate from `yaos_sync_jobs`. The YAOS outbox has a different delivery contract and must not be reused.
- Executor candidate: Cloudflare Workflows for durable, checkpointed orchestration, after validating Free-plan constraints; GitHub Actions is reserved for repository/code tasks such as checks and PR preparation.
- Recovery: task state, attempt budget, deadline, checkpoint and failure reason remain in D1 even if an executor instance expires.
- Production safety: this document and the candidate migration do not authorize production D1 writes, migration application, Worker deployment, or secret changes.

## Required state machine

`queued -> running -> waiting -> running -> succeeded`

Terminal alternatives: `failed` and `cancelled`. A lease expiry may return a task to `queued` only if its retry budget and deadline still permit it. A terminal task must never be automatically re-enqueued.

## Retry policy

Retry is permitted only for errors explicitly classified as transient. Authentication/authorization errors, invalid input, policy/safety guard failures, credential detection, and PII-masking failures stop immediately. Every retry consumes the persisted attempt budget. Exponential delay is capped. A task also stops when its wall-clock deadline, AI-call budget, or token budget is exhausted. Manual restart must not silently reset the failed operation's budget.

Initial conservative defaults (tune only with test evidence):
- Maximum attempts per operation: 4 total attempts.
- Backoff: 30 seconds, then 60, then 120 seconds; capped at 30 minutes.
- Maximum task wall-clock age: 1 hour.
- Maximum AI calls per task: 20.
- Maximum AI tokens per task: 40,000 (count actual provider usage when available; conservatively account for estimated input/output otherwise).

These are application-level ceilings, not a claim that Cloudflare's retry configuration enforces them.

## Cloudflare Free-plan constraints checked 2026-10-20

Official docs:
- Workflows pricing: https://developers.cloudflare.com/workflows/reference/pricing/
- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/

Current published Free allowances include 3,000 Workflow steps/day and 1 GB-month of persisted Workflow state. Workflows Free steps have a 10 ms CPU limit; a step may wait on network I/O without consuming CPU during the wait. Workers Free also has 100,000 requests/day and 10 ms CPU per invocation. Default Workflow state retention on Free is 3 days. The design must keep steps small, minimize step count, avoid busy polling, and persist user-visible status independently in D1. Usage above the Free limits must fail safely rather than silently switch to paid usage.

## Implementation sequence

1. Add a standalone retry-policy module and deterministic unit tests.
2. Add the pending D1 schema for task records; do not execute it against production.
3. Add claim/lease/checkpoint/state-transition functions with concurrency tests.
4. Add a Workflow binding and intake endpoint only after the schema and deployment constraints are reviewed.
5. Verify restart/recovery and retry exhaustion locally; document production migration/rollback separately.

## Non-negotiable safety rules

- Inspect assembled AI-bound content for credentials immediately before sending; block if detected.
- Mask personal information before sending to AI.
- Do not add an `ai_allowed` switch or per-operation AI permission gate.
- Telegram may modify behavioral specifications, but cannot modify these mandatory security rules.
- No automatic production deploy, D1 migration, or live note mutation as part of the initial implementation PR.
