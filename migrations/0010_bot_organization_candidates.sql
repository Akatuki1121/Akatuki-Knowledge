-- Schema for approval-gated Telegram folder organization proposals.
-- Recorded in the production ledger (applied_at 2026-10-21 16:00:54 UTC, after 0011 and 0012). The live schema matched this file on 2026-10-22.
-- No note paths are changed by this migration.

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
