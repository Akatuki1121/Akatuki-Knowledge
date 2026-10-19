
-- YAOSへのイベント駆動同期用キュー

CREATE TABLE yaos_sync_jobs (

    job_id INTEGER PRIMARY KEY AUTOINCREMENT,

    event_id TEXT NOT NULL UNIQUE,

    entity_type TEXT NOT NULL

        CHECK (entity_type IN ('notes', 'telegram_notes')),

    entity_id TEXT NOT NULL,

    operation TEXT NOT NULL

        CHECK (operation IN ('upsert', 'delete')),

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

-- 送信可能なジョブの取得

CREATE INDEX idx_yaos_sync_jobs_ready

    ON yaos_sync_jobs(status, next_attempt_at, created_at);

-- 同じノートに対するイベントの追跡

CREATE INDEX idx_yaos_sync_jobs_entity

    ON yaos_sync_jobs(entity_type, entity_id, created_at);

-- 処理中に停止したジョブの回収

CREATE INDEX idx_yaos_sync_jobs_lease

    ON yaos_sync_jobs(status, lease_expires_at);

