-- Pending schema for explicit, expiring Telegram bulk AI-permission previews.
-- Apply only after reviewing the Worker rollout; this does not change note permissions.
CREATE TABLE bot_ai_permission_previews (
    chat_id TEXT PRIMARY KEY,
    candidates_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending'))
);

CREATE INDEX idx_bot_ai_permission_previews_expiry
    ON bot_ai_permission_previews(expires_at);
