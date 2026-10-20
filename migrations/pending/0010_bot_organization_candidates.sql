-- Pending schema addition for approval-gated Telegram folder organization proposals.
-- Apply only after reviewing the Worker changes; no note paths are changed by this migration.

CREATE TABLE bot_organization_candidates (
    candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX idx_bot_organization_candidates_pending
    ON bot_organization_candidates(chat_id, status, candidate_id);
