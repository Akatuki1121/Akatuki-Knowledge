-- Pull execution history. This migration is intentionally pending until an owner-approved D1 rollout.
CREATE TABLE IF NOT EXISTS vault_pull_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'post_write', 'manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  stage TEXT,
  error_code TEXT,
  queued INTEGER,
  created INTEGER,
  updated INTEGER,
  vault_files INTEGER,
  reconcile_scanned INTEGER,
  reconcile_matched INTEGER,
  reconcile_missing_in_vault INTEGER,
  reconcile_content_conflicts INTEGER,
  reconcile_duplicate_paths INTEGER,
  reconcile_uuid_conflicts INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vault_pull_runs_started_at
  ON vault_pull_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_vault_pull_runs_trigger_started_at
  ON vault_pull_runs (trigger, started_at);

-- Deliberately no cascading foreign key: changes are retained for 180 days,
-- while run summaries are retained for 30 days.
CREATE TABLE IF NOT EXISTS vault_pull_changes (
  run_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  source_modified_at TEXT,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
);

CREATE INDEX IF NOT EXISTS idx_vault_pull_changes_applied_at
  ON vault_pull_changes (applied_at);
