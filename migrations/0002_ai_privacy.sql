ALTER TABLE notes ADD COLUMN ai_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'unknown';
CREATE TABLE IF NOT EXISTS ai_audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  note_count INTEGER NOT NULL DEFAULT 0,
  finding_ids_json TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL,
  sent_chars INTEGER NOT NULL DEFAULT 0,
  result_code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_audit_created ON ai_audit(created_at DESC);
