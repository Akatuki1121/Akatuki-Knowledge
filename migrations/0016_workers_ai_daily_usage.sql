-- Account for Workers AI consumption against the Cloudflare Free daily Neurons allocation.
-- Keep only aggregate counters; prompts, completions, and user content are never stored.
CREATE TABLE IF NOT EXISTS workers_ai_daily_usage (
  usage_day TEXT PRIMARY KEY,
  reserved_neurons INTEGER NOT NULL DEFAULT 0 CHECK (reserved_neurons >= 0),
  actual_neurons INTEGER NOT NULL DEFAULT 0 CHECK (actual_neurons >= 0),
  calls_completed INTEGER NOT NULL DEFAULT 0 CHECK (calls_completed >= 0),
  updated_at TEXT NOT NULL
);
