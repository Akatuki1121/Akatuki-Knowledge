-- Natural conversational capture, reversible writes, and approved behavior improvements.
ALTER TABLE notes ADD COLUMN knowledge_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE notes ADD COLUMN knowledge_scope TEXT NOT NULL DEFAULT 'project';
ALTER TABLE telegram_notes ADD COLUMN knowledge_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE telegram_notes ADD COLUMN knowledge_scope TEXT NOT NULL DEFAULT 'project';

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
CREATE INDEX idx_telegram_note_actions_recent ON telegram_note_actions(chat_id, created_at DESC);
CREATE UNIQUE INDEX idx_telegram_note_actions_source ON telegram_note_actions(chat_id, source_message_id);

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
CREATE INDEX idx_bot_improvements_pending ON bot_improvement_candidates(chat_id, status, created_at DESC);

CREATE TABLE bot_behavior_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(category IN ('response_style', 'memory_capture', 'search_behavior')),
  rule_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bot_behavior_rules_active ON bot_behavior_rules(active, category);

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
CREATE INDEX idx_note_archive_events_note ON note_archive_events(note_id, archived_at DESC);
