-- Issue #75 slice 1: daily counters for shadow intent classification (B3 measurement).
-- Stores aggregate counts only: day x route x source. Never stores message text,
-- classifier free text, or raw model output.
-- PENDING: not applied to production D1. While this file stays in migrations/pending/,
-- the GitHub Actions production deploy gate stays closed. Apply only through the
-- separately reviewed D1 rollout, then move this file up to migrations/.
CREATE TABLE IF NOT EXISTS intent_classifier_counters (
    day TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('conversation', 'knowledge_query', 'web_research', 'github_task', 'abstain', 'tier0')),
    source TEXT NOT NULL CHECK (source IN ('tier0', 'shadow', 'schema_invalid', 'low_score', 'low_margin', 'slot_missing', 'model_error', 'daily_limit', 'sensitive')),
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (day, route, source)
);

CREATE INDEX IF NOT EXISTS idx_intent_classifier_counters_day
    ON intent_classifier_counters(day);
