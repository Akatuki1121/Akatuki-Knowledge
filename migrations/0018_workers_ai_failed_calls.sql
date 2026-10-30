-- Track failed Workers AI requests separately from successful responses.
-- Failed requests are settled conservatively using estimated input tokens only.
ALTER TABLE workers_ai_daily_usage
ADD COLUMN calls_failed INTEGER NOT NULL DEFAULT 0 CHECK (calls_failed >= 0);
