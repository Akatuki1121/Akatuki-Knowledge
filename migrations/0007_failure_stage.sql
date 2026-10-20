-- Record only which organizer stage failed (never error text or note content) so retries can be diagnosed.
ALTER TABLE notes ADD COLUMN last_failure_stage TEXT;
ALTER TABLE telegram_notes ADD COLUMN last_failure_stage TEXT;
