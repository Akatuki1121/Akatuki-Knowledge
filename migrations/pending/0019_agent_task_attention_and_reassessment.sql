-- Add a durable attention state and policy-versioned reassessment for improvement tasks.
-- Existing task IDs, attempts, checkpoints, reservations, and error details are preserved.
DROP INDEX IF EXISTS idx_agent_tasks_ready;
DROP INDEX IF EXISTS idx_agent_tasks_lease;
DROP INDEX IF EXISTS idx_agent_tasks_deadline;

ALTER TABLE agent_tasks RENAME TO agent_tasks_before_attention;

CREATE TABLE agent_tasks (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'needs_attention')),
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
    notification_last_error_class TEXT,
    retry_policy_version INTEGER NOT NULL DEFAULT 0 CHECK (retry_policy_version >= 0)
);

INSERT INTO agent_tasks (
    task_id, idempotency_key, task_type, status, budget_reserved, payload_json, checkpoint_json,
    attempts, max_attempts, ai_calls_used, max_ai_calls, ai_tokens_used, max_ai_tokens,
    created_at, updated_at, deadline_at, next_attempt_at, lease_token, lease_expires_at,
    started_at, completed_at, last_error_class, last_error, stop_reason, notify_chat_id,
    notification_status, notification_attempts, notification_next_attempt_at,
    notification_lease_expires_at, notification_last_error_class, retry_policy_version
)
SELECT
    task_id, idempotency_key, task_type, status, budget_reserved, payload_json, checkpoint_json,
    attempts, max_attempts, ai_calls_used, max_ai_calls, ai_tokens_used, max_ai_tokens,
    created_at, updated_at, deadline_at, next_attempt_at, lease_token, lease_expires_at,
    started_at, completed_at, last_error_class, last_error, stop_reason, notify_chat_id,
    notification_status, notification_attempts, notification_next_attempt_at,
    notification_lease_expires_at, notification_last_error_class, 0
FROM agent_tasks_before_attention;

DROP TABLE agent_tasks_before_attention;

CREATE INDEX idx_agent_tasks_ready
    ON agent_tasks(status, next_attempt_at, created_at);

CREATE INDEX idx_agent_tasks_lease
    ON agent_tasks(status, lease_expires_at);

CREATE INDEX idx_agent_tasks_deadline
    ON agent_tasks(status, deadline_at);
