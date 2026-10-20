-- Production schema extension for YAOS event-driven synchronization.
-- Applied to the existing production D1 on 2026-10-20 after verifying the folder schema was already present.
-- The production migration ledger records 0008_folders_schema_reconstructed.sql and this 0009 migration.
-- This migration depends on the existing notes/note_revisions tables and is not a clean-database bootstrap.
-- Original historical migrations 0001-0007 remain unrecovered; do not treat the repository as a fresh-DB bootstrap yet.

-- UUID index used to reconcile Obsidian path moves without changing the stable D1 row ID.
ALTER TABLE notes ADD COLUMN sync_uuid TEXT;
CREATE INDEX idx_notes_sync_uuid ON notes(sync_uuid);

CREATE TABLE yaos_sync_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('notes', 'telegram_notes')),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT
);

CREATE INDEX idx_yaos_sync_jobs_ready
    ON yaos_sync_jobs(status, next_attempt_at, created_at);

CREATE INDEX idx_yaos_sync_jobs_entity
    ON yaos_sync_jobs(entity_type, entity_id, created_at);

CREATE INDEX idx_yaos_sync_jobs_lease
    ON yaos_sync_jobs(status, lease_expires_at);
