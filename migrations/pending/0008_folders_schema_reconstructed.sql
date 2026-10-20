-- Reconstructed forward migration for the folder schema observed in live D1.
-- This is NOT claimed to be the original historical change.
-- Production already has this schema but its d1_migrations ledger does not record its origin.
-- Do not apply directly to production: reconcile/record the already-present schema first.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  full_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE notes ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_folders_kind ON folders(kind);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
