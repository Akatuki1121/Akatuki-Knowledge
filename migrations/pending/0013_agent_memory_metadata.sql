CREATE TABLE agent_memory_metadata (
    source TEXT NOT NULL CHECK (source IN ('obsidian', 'telegram')),
    note_id TEXT NOT NULL,
    memory_kind TEXT NOT NULL CHECK (
        memory_kind IN ('fact', 'preference', 'constraint', 'decision', 'temporary_state', 'procedure', 'hypothesis')
    ),
    trust_level TEXT NOT NULL CHECK (
        trust_level IN ('user_stated', 'user_confirmed', 'inferred', 'external')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'unverified', 'conflicted', 'forgotten', 'superseded')
    ),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_ref TEXT NOT NULL,
    memory_key_hash TEXT NOT NULL CHECK (length(memory_key_hash) = 64),
    value_hash TEXT NOT NULL CHECK (length(value_hash) = 64),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    recorded_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmed_at TEXT,
    expires_at TEXT,
    PRIMARY KEY (source, note_id, memory_key_hash, value_hash)
);

CREATE INDEX idx_agent_memory_status_expiry
    ON agent_memory_metadata(status, expires_at);
CREATE INDEX idx_agent_memory_key_status
    ON agent_memory_metadata(memory_key_hash, status);

CREATE TABLE agent_memory_suppressions (
    suppression_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('obsidian', 'telegram')),
    note_id TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    memory_key_hash TEXT CHECK (memory_key_hash IS NULL OR length(memory_key_hash) = 64),
    value_hash TEXT CHECK (value_hash IS NULL OR length(value_hash) = 64),
    created_at TEXT NOT NULL,
    UNIQUE (source, note_id, content_hash, memory_key_hash, value_hash)
);

CREATE INDEX idx_agent_memory_suppression_content
    ON agent_memory_suppressions(content_hash);
CREATE INDEX idx_agent_memory_suppression_key
    ON agent_memory_suppressions(memory_key_hash);
CREATE UNIQUE INDEX idx_agent_memory_suppression_content_only
    ON agent_memory_suppressions(source, note_id, content_hash)
    WHERE memory_key_hash IS NULL AND value_hash IS NULL;
