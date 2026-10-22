#!/usr/bin/env python3
"""Exercise agent-memory schema constraints and forget suppression in isolated SQLite."""
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "pending" / "0013_agent_memory_metadata.sql"
connection = sqlite3.connect(":memory:")
connection.executescript(MIGRATION.read_text(encoding="utf-8"))

columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_memory_metadata)")}
assert {
    "source", "note_id", "memory_kind", "trust_level", "status", "confidence",
    "source_ref", "memory_key_hash", "value_hash", "content_hash", "recorded_at",
    "updated_at", "confirmed_at", "expires_at",
} <= columns

hash_a = "a" * 64
hash_b = "b" * 64
hash_c = "c" * 64
hash_d = "d" * 64
now = "2026-10-22T12:00:00.000Z"
connection.executemany(
    """
    INSERT INTO agent_memory_metadata (
        source, note_id, memory_kind, trust_level, status, confidence, source_ref,
        memory_key_hash, value_hash, content_hash, recorded_at, updated_at
    ) VALUES ('telegram', ?, 'fact', 'user_stated', 'active', 0.95, 'telegram:chat:1', ?, ?, ?, ?, ?)
    """,
    [
        ("tg:chat:1", hash_a, hash_b, hash_c, now, now),
        ("tg:chat:1", hash_a, hash_d, hash_c, now, now),
    ],
)
assert connection.execute(
    "SELECT COUNT(*) FROM agent_memory_metadata WHERE note_id = 'tg:chat:1'"
).fetchone()[0] == 2, "One note must support multiple values for a memory key"

connection.execute(
    """
    INSERT OR IGNORE INTO agent_memory_suppressions (
        source, note_id, content_hash, memory_key_hash, value_hash, created_at
    )
    SELECT ?, ?, ?, memory_key_hash, value_hash, ?
    FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    UNION ALL
    SELECT ?, ?, ?, NULL, NULL, ?
    WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    )
    """,
    (
        "telegram", "tg:chat:1", hash_c, now, "telegram", "tg:chat:1",
        "telegram", "tg:chat:1", hash_c, now, "telegram", "tg:chat:1",
    ),
)
suppressed = connection.execute(
    "SELECT memory_key_hash, value_hash FROM agent_memory_suppressions WHERE note_id = 'tg:chat:1'"
).fetchall()
assert set(suppressed) == {(hash_a, hash_b), (hash_a, hash_d)}
assert connection.execute(
    """
    SELECT 1 FROM agent_memory_suppressions
    WHERE content_hash = ? OR memory_key_hash = ? OR value_hash = ? LIMIT 1
    """,
    ("e" * 64, hash_a, "e" * 64),
).fetchone(), "A forgotten memory key must suppress a differently worded value"

connection.execute(
    "UPDATE agent_memory_metadata SET status = 'forgotten', updated_at = ? WHERE source = ? AND note_id = ?",
    (now, "telegram", "tg:chat:1"),
)
assert connection.execute(
    "SELECT COUNT(*) FROM agent_memory_metadata WHERE status = 'forgotten'"
).fetchone()[0] == 2

connection.execute(
    """
    INSERT OR IGNORE INTO agent_memory_suppressions (
        source, note_id, content_hash, memory_key_hash, value_hash, created_at
    )
    SELECT ?, ?, ?, memory_key_hash, value_hash, ?
    FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    UNION ALL
    SELECT ?, ?, ?, NULL, NULL, ?
    WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    )
    """,
    (
        "obsidian", "legacy-note", hash_c, now, "obsidian", "legacy-note",
        "obsidian", "legacy-note", hash_c, now, "obsidian", "legacy-note",
    ),
)
connection.execute(
    """
    INSERT OR IGNORE INTO agent_memory_suppressions (
        source, note_id, content_hash, memory_key_hash, value_hash, created_at
    )
    SELECT ?, ?, ?, memory_key_hash, value_hash, ?
    FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    UNION ALL
    SELECT ?, ?, ?, NULL, NULL, ?
    WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_metadata WHERE source = ? AND note_id = ?
    )
    """,
    (
        "obsidian", "legacy-note", hash_c, now, "obsidian", "legacy-note",
        "obsidian", "legacy-note", hash_c, now, "obsidian", "legacy-note",
    ),
)
assert connection.execute(
    "SELECT COUNT(*) FROM agent_memory_suppressions WHERE note_id = 'legacy-note'"
).fetchone()[0] == 1, "Repeated deletion must not duplicate content-only suppressions"

print("Agent-memory migration constraints and suppression behavior passed in isolated SQLite.")
