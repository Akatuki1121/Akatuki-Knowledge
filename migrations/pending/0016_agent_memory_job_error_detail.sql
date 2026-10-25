-- Record which stage of memory-job processing failed and a sanitized, length-capped
-- summary of the failure (never raw error text, message content, or secrets) so a
-- memory_processing_failed job can be diagnosed from D1 alone (Issue #63).
-- Observation only: retry policy and error classification are unchanged.
ALTER TABLE agent_memory_jobs ADD COLUMN last_error_stage TEXT;
ALTER TABLE agent_memory_jobs ADD COLUMN last_error_detail TEXT;
