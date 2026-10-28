-- D1-authoritative Obsidian identity separation.
-- Applied to production D1 after owner authorization and schema verification.
-- YAOS is unchanged; this table stores the Akatuki-side mapping only.

CREATE TABLE IF NOT EXISTS yaos_file_identity_map (
  file_id TEXT PRIMARY KEY,
  sync_uuid TEXT NOT NULL UNIQUE,
  note_id TEXT NOT NULL UNIQUE,
  last_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (note_id) REFERENCES notes(id)
);

CREATE INDEX IF NOT EXISTS idx_yaos_file_identity_path
  ON yaos_file_identity_map(last_path);

CREATE TABLE IF NOT EXISTS yaos_sync_identity_review (
  file_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('deferred', 'needs_review')),
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yaos_sync_identity_review_classification
  ON yaos_sync_identity_review(classification, last_seen_at);
