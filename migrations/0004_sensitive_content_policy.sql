-- Re-enable previously held sensitive notes. The organizer still blocks actual credentials
-- and redacts configured identifiers before any Gemini request.
UPDATE notes
SET review_state = 'ready', sensitivity = 'unknown', next_retry_at = NULL
WHERE review_state = 'pending_confirmation' AND deleted_at IS NULL;

UPDATE telegram_notes
SET ai_allowed = 1, review_state = 'ready', sensitivity = 'unknown', next_retry_at = NULL
WHERE review_state = 'pending_confirmation' AND deleted_at IS NULL;
