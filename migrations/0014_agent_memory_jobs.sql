-- Durable queue for asynchronous extraction of useful memories from safe Telegram messages.
-- This queue is separate from agent_tasks because memory extraction is a small maintenance job,
-- not a user-visible multi-step Workflow with its own daily Workflow-step reservation.
CREATE TABLE agent_memory_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'discarded')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at TEXT,
    last_error_class TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    UNIQUE (chat_id, message_id)
);

CREATE INDEX idx_agent_memory_jobs_ready
    ON agent_memory_jobs(status, next_attempt_at, created_at);

CREATE INDEX idx_agent_memory_jobs_lease
    ON agent_memory_jobs(status, lease_expires_at);
