-- Schema for explicit, expiring Telegram bulk AI-permission previews.
-- Recorded in the production ledger (applied_at 2026-10-21 03:18:46 UTC). The live schema matched this file on 2026-10-22.
-- This does not change note permissions.
CREATE TABLE bot_ai_permission_previews (
    chat_id TEXT PRIMARY KEY,
    candidates_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending'))
);

CREATE INDEX idx_bot_ai_permission_previews_expiry
    ON bot_ai_permission_previews(expires_at);
