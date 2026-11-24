-- 読み取り専用の巡回監査結果と集合状態を保存する。
-- 本番 D1 への適用は所有者によるレビュー・承認後に行う。
CREATE TABLE IF NOT EXISTS audit_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  set_total INTEGER NOT NULL DEFAULT 0,
  patrol_total INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  notification_text TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_started
  ON audit_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS audit_findings (
  finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('obsidian', 'telegram')),
  note_id TEXT NOT NULL,
  path TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('stagnant', 'quarantined_overlap', 'pathless_aged', 'set_out')),
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES audit_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_findings_run
  ON audit_findings(run_id, kind);

CREATE INDEX IF NOT EXISTS idx_audit_findings_note
  ON audit_findings(source, note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_note_state (
  source TEXT NOT NULL CHECK (source IN ('obsidian', 'telegram')),
  note_id TEXT NOT NULL,
  last_seen_hash TEXT,
  first_seen_in_set_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_path TEXT,
  PRIMARY KEY (source, note_id)
);
