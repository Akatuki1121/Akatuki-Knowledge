-- Reconstructed forward migration for the folder schema observed in live D1.
-- This is NOT claimed to be the original historical change.
-- Production already had this schema before the ledger recorded it; the ledger now lists this file (applied_at 2026-10-20 06:10:38 UTC).
-- The live schema was compared with this file on 2026-10-22 (tables, columns, foreign keys, indexes) and matched.
-- Do not run it against production again: ALTER TABLE notes ADD COLUMN folder_id would fail on the existing column.
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
