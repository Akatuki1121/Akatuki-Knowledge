-- Durable, deduplicated operational notifications sent to the configured Telegram chat.
CREATE TABLE bot_alerts (
  alert_key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('gemini_limit', 'configuration', 'processing_failure')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent')),
  next_attempt_at TEXT NOT NULL,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT,
  sent_at TEXT
);
CREATE INDEX idx_bot_alerts_pending ON bot_alerts(status, next_attempt_at, first_seen_at);
