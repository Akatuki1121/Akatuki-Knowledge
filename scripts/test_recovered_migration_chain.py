#!/usr/bin/env python3
"""Apply recovered D1 migrations to scratch SQLite and compare schema shape with live capture.

This is a local, in-memory validation only. It never connects to Cloudflare and does not
prove that the recovered SQL is byte-for-byte identical to the SQL originally applied.
"""
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
LIVE_SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
EXPECTED = [
    "0001_initial.sql",
    "0002_ai_privacy.sql",
    "0003_telegram_workflow.sql",
    "0004_sensitive_content_policy.sql",
    "0005_conversation_memory.sql",
    "0006_bot_alerts.sql",
    "0007_failure_stage.sql",
]
IGNORED_TABLES = {"_cf_KV", "d1_migrations", "d1_migrations_legacy_backup", "sqlite_sequence"}

def schema(sql_files):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for path in sql_files:
        db.executescript(path.read_text(encoding="utf-8"))
    tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ) if row[0] not in IGNORED_TABLES
    }
    columns = {
        table: {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
        for table in tables
    }
    fk_errors = list(db.execute("PRAGMA foreign_key_check"))
    if fk_errors:
        raise AssertionError(f"Foreign-key errors after {sql_files[-1].name}: {fk_errors}")
    db.close()
    return tables, columns

paths = [MIGRATIONS / name for name in EXPECTED]\npaths.append(MIGRATIONS / "pending" / "0008_folders_schema_reconstructed.sql")
missing_files = [path.name for path in paths if not path.is_file()]
if missing_files:
    raise SystemExit(f"Recovered migration files missing: {missing_files}")

migrated_tables, migrated_columns = schema(paths)
live_tables, live_columns = schema([LIVE_SCHEMA])

missing_tables = live_tables - migrated_tables
unexpected_tables = migrated_tables - live_tables
missing_columns = {
    table: live_columns[table] - migrated_columns.get(table, set())
    for table in live_tables & migrated_tables
    if live_columns[table] - migrated_columns.get(table, set())
}
unexpected_columns = {
    table: migrated_columns[table] - live_columns.get(table, set())
    for table in migrated_tables & live_tables
    if migrated_columns[table] - live_columns.get(table, set())
}

# This is the known drift observed in the captured live database. Fail if any other
# table/column discrepancy appears, or if this known discrepancy changes unexpectedly.
expected_missing_tables = {"folders"}
expected_missing_columns = {"notes": {"folder_id"}}
assert missing_tables == expected_missing_tables, (
    f"Live-only tables differ from the documented drift: {missing_tables}"
)
assert missing_columns == expected_missing_columns, (
    f"Live-only columns differ from the documented drift: {missing_columns}"
)
assert not unexpected_tables, f"Migration-only tables not in live capture: {unexpected_tables}"
assert not unexpected_columns, f"Migration-only columns not in live capture: {unexpected_columns}"

print(
    "PASS: migrations 0001-0007 plus pending folder migration apply in order to empty SQLite and match the captured "
    "live schema shape after applying the pending reconstructed folder-schema migration."
)
print(
    "NOTE: this proves structural compatibility only; it does not prove the recovered SQL "
    "is identical to the original SQL applied in production."
)
