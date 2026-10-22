-- Schema for background agent tasks and the daily Workflow-step budget.
-- Recorded in the production ledger (applied_at 2026-10-21 03:18:46 UTC). The live schema matched this file on 2026-10-22.
-- See docs/BACKGROUND_TASKS.md and GitHub Issue #29.
CREATE TABLE agent_tasks (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
    budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved IN (0, 1)),
    payload_json TEXT NOT NULL DEFAULT '{}',
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
    ai_calls_used INTEGER NOT NULL DEFAULT 0 CHECK (ai_calls_used >= 0),
    max_ai_calls INTEGER NOT NULL DEFAULT 20 CHECK (max_ai_calls > 0),
    ai_tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (ai_tokens_used >= 0),
    max_ai_tokens INTEGER NOT NULL DEFAULT 40000 CHECK (max_ai_tokens > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deadline_at TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_token TEXT,
    lease_expires_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    last_error_class TEXT,
    last_error TEXT,
    stop_reason TEXT,
    notify_chat_id TEXT,
    notification_status TEXT NOT NULL DEFAULT 'none'
        CHECK (notification_status IN ('none', 'pending', 'sending', 'sent', 'failed')),
    notification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (notification_attempts >= 0),
    notification_next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    notification_lease_expires_at TEXT,
    notification_last_error_class TEXT
);

CREATE INDEX idx_agent_tasks_ready
    ON agent_tasks(status, next_attempt_at, created_at);

CREATE INDEX idx_agent_tasks_lease
    ON agent_tasks(status, lease_expires_at);

CREATE INDEX idx_agent_tasks_deadline
    ON agent_tasks(status, deadline_at);

-- Conservative daily admission budget: reserve 32 Workflow steps per task,
-- allow at most 60 tasks / 2,000 reserved steps per UTC day, leaving margin
-- under the published 3,000 Workflow steps/day Free allowance.
CREATE TABLE agent_task_daily_budget (
    budget_day TEXT PRIMARY KEY,
    tasks_reserved INTEGER NOT NULL DEFAULT 0 CHECK (tasks_reserved BETWEEN 0 AND 60),
    workflow_steps_reserved INTEGER NOT NULL DEFAULT 0 CHECK (workflow_steps_reserved BETWEEN 0 AND 2000),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- Idempotent admission ledger: a task can consume the daily reservation only once.
-- The ledger and counter update are written in one D1 batch transaction.
CREATE TABLE agent_task_budget_reservations (
    task_id TEXT PRIMARY KEY,
    budget_day TEXT NOT NULL,
    workflow_steps INTEGER NOT NULL DEFAULT 32 CHECK (workflow_steps = 32),
    counted INTEGER NOT NULL DEFAULT 0 CHECK (counted IN (0, 1, 2))
);

CREATE INDEX idx_agent_task_budget_reservations_day
    ON agent_task_budget_reservations(budget_day, counted);
