-- Keep the existing Obsidian notes table intact; add fields needed by the common organizer.
ALTER TABLE notes ADD COLUMN ai_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE notes ADD COLUMN organization_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN next_retry_at TEXT;
ALTER TABLE notes ADD COLUMN review_state TEXT NOT NULL DEFAULT 'ready';
CREATE INDEX idx_notes_organization_retry ON notes(ai_allowed, review_state, next_retry_at, updated_at);

-- Telegram notes have IDs and no synthetic file path.
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
  deleted_at TEXT,
  UNIQUE(chat_id, message_id)
);
CREATE INDEX idx_telegram_notes_retry ON telegram_notes(ai_allowed, review_state, next_retry_at, updated_at);
CREATE INDEX idx_telegram_notes_chat ON telegram_notes(chat_id, updated_at DESC);

CREATE TABLE telegram_note_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_revisions_note_saved ON telegram_note_revisions(note_id, saved_at DESC);

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
CREATE INDEX idx_telegram_messages_chat_time ON telegram_messages(chat_id, created_at DESC);

CREATE TABLE note_relations (
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_note_id, target_note_id),
  CHECK (source_note_id <> target_note_id)
);
CREATE INDEX idx_note_relations_target ON note_relations(target_note_id);
