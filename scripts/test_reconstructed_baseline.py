#!/usr/bin/env python3
"""Validate reconstructed schema in an empty SQLite database; never connects to Cloudflare."""
import sqlite3
import sys
from pathlib import Path

sql_path = Path(sys.argv[1] if len(sys.argv) > 1 else "bootstrap/0001_baseline_reconstructed.sql")
db = sqlite3.connect(":memory:")
db.executescript(sql_path.read_text(encoding="utf-8"))

tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
indexes = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
required = {
    "notes", "folders", "note_revisions", "note_relations", "note_archive_events",
    "telegram_notes", "telegram_messages", "telegram_updates", "telegram_note_actions",
    "telegram_note_revisions", "ai_audit", "bot_alerts",
}
missing = sorted(required - tables)
if missing:
    raise SystemExit(f"Missing required tables: {missing}")
if "d1_migrations" in tables or "_cf_KV" in tables:
    raise SystemExit("Internal migration/KV table unexpectedly included in baseline")
fk_errors = list(db.execute("PRAGMA foreign_key_check"))
if fk_errors:
    raise SystemExit(f"Foreign-key declaration errors: {fk_errors}")
print(f"PASS: {len(tables)} tables and {len(indexes)} indexes created in empty SQLite database")
