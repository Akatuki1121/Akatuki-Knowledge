-- Legacy repository file preserved during recovery on 2026-10-19.
-- This file is NOT a verified D1 migration: it contains the evolved schema,
-- including the d1_migrations table itself, and must not be applied by Wrangler.
-- The live schema capture is available at live-d1-schema-2026-10-19.sql.
-- Original migrations 0001-0007 still need to be recovered from source history.

CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID;
CREATE TABLE note_revisions (revision_id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, saved_at TEXT NOT NULL);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ai_audit (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, action TEXT NOT NULL, note_count INTEGER NOT NULL DEFAULT 0, finding_ids_json TEXT NOT NULL DEFAULT '[]', risk TEXT NOT NULL, sent_chars INTEGER NOT NULL DEFAULT 0, result_code TEXT NOT NULL);
CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, source_modified_at TEXT, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', summary TEXT, related_json TEXT NOT NULL DEFAULT '[]', organized_hash TEXT, deleted_at TEXT, ai_allowed INTEGER NOT NULL DEFAULT 0, sensitivity TEXT NOT NULL DEFAULT 'unknown', ai_tags_json TEXT NOT NULL DEFAULT '[]', organization_failures INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, review_state TEXT NOT NULL DEFAULT 'ready', knowledge_type TEXT NOT NULL DEFAULT 'unknown', knowledge_scope TEXT NOT NULL DEFAULT 'project', last_failure_stage TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);
CREATE TABLE telegram_notes (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  ai_tags_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  related_json TEXT NOT NULL DEFAULT '[]',
  organized_hash TEXT,
  ai_allowed INTEGER NOT NULL DEFAULT 1,
  sensitivity TEXT NOT NULL DEFAULT 'unknown',
  review_state TEXT NOT NULL DEFAULT 'ready',
  organization_failures INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  deleted_at TEXT, knowledge_type TEXT NOT NULL DEFAULT 'unknown', knowledge_scope TEXT NOT NULL DEFAULT 'project', last_failure_stage TEXT,
  UNIQUE(chat_id, message_id)
);
CREATE TABLE telegram_note_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  result_code TEXT NOT NULL
);
CREATE TABLE telegram_messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE note_relations (
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_note_id, target_note_id),
  CHECK (source_note_id <> target_note_id)
);
CREATE TABLE d1_migrations_legacy_backup(
  name TEXT,
  applied_at INT
);
CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE telegram_note_actions (
  action_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('create', 'append')),
  before_title TEXT,
  before_content TEXT,
  before_hash TEXT,
  after_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverted_at TEXT
);
CREATE TABLE bot_improvement_candidates (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('response_style', 'memory_capture', 'search_behavior')),
  proposal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  applied_version INTEGER
);
CREATE TABLE bot_behavior_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(category IN ('response_style', 'memory_capture', 'search_behavior')),
  rule_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE bot_policy_revisions (
  version INTEGER PRIMARY KEY,
  rules_json TEXT NOT NULL,
  source_candidate_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE note_archive_events (
  archive_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('obsidian', 'telegram')),
  previous_ai_allowed INTEGER NOT NULL,
  previous_review_state TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  restored_at TEXT
);
CREATE TABLE bot_alerts (
  alert_key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('gemini_limit', 'configuration', 'processing_failure')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent')),
  next_attempt_at TEXT NOT NULL,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT,
  sent_at TEXT
);
CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE, kind TEXT NOT NULL, full_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));

