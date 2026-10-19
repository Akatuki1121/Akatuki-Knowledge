#!/usr/bin/env python3
"""Apply recovered D1 migrations to scratch SQLite and compare schema structure with live capture.

This is an in-memory validation only. It never connects to Cloudflare and does not
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
        table: sorted(
            (row[1], row[2].upper(), row[3], row[4], row[5])
            for row in db.execute(f'PRAGMA table_info("{table}")')
        )
        for table in tables
    }
    foreign_keys = {
        table: sorted(
            (row[2], row[3], row[4], row[5].upper(), row[6].upper(), row[7].upper())
            for row in db.execute(f'PRAGMA foreign_key_list("{table}")')
        )
        for table in tables
    }
    indexes = {}
    for table in tables:
        table_indexes = {}
        for row in db.execute(f'PRAGMA index_list("{table}")'):
            name, unique, origin, partial = row[1], row[2], row[3], row[4]
            index_columns = tuple(
                item[2] for item in db.execute(f'PRAGMA index_info("{name}")')
            )
            table_indexes[name] = (unique, origin, partial, index_columns)
        indexes[table] = table_indexes

    fk_errors = list(db.execute("PRAGMA foreign_key_check"))
    if fk_errors:
        raise AssertionError(f"Foreign-key errors after {sql_files[-1].name}: {fk_errors}")
    db.close()
    return {
        "tables": tables,
        "columns": columns,
        "foreign_keys": foreign_keys,
        "indexes": indexes,
    }


paths = [MIGRATIONS / name for name in EXPECTED]
paths.append(MIGRATIONS / "pending" / "0008_folders_schema_reconstructed.sql")
missing_files = [path.name for path in paths if not path.is_file()]
if missing_files:
    raise SystemExit(f"Recovered migration files missing: {missing_files}")

migrated = schema(paths)
live = schema([LIVE_SCHEMA])

missing_tables = live["tables"] - migrated["tables"]
unexpected_tables = migrated["tables"] - live["tables"]
missing_columns = {
    table: sorted(set(live["columns"][table]) - set(migrated["columns"].get(table, [])))
    for table in live["tables"] & migrated["tables"]
    if set(live["columns"][table]) - set(migrated["columns"].get(table, []))
}
unexpected_columns = {
    table: sorted(set(migrated["columns"][table]) - set(live["columns"].get(table, [])))
    for table in migrated["tables"] & live["tables"]
    if set(migrated["columns"][table]) - set(live["columns"].get(table, []))
}
foreign_key_differences = {
    table: {"live": live["foreign_keys"][table], "migrated": migrated["foreign_keys"][table]}
    for table in live["tables"] & migrated["tables"]
    if live["foreign_keys"][table] != migrated["foreign_keys"][table]
}
index_differences = {
    table: {"live": live["indexes"][table], "migrated": migrated["indexes"][table]}
    for table in live["tables"] & migrated["tables"]
    if live["indexes"][table] != migrated["indexes"][table]
}

assert not missing_tables, f"Tables missing from reconstructed chain: {missing_tables}"
assert not unexpected_tables, f"Migration-only tables not in live capture: {unexpected_tables}"
assert not missing_columns, f"Column definitions missing/different in reconstructed chain: {missing_columns}"
assert not unexpected_columns, f"Unexpected/different column definitions in reconstructed chain: {unexpected_columns}"
assert not foreign_key_differences, f"Foreign-key definitions differ: {foreign_key_differences}"
assert not index_differences, f"Index definitions differ: {index_differences}"

print(
    "PASS: migrations 0001-0007 plus the pending folder migration apply in order to empty SQLite "
    "and match the captured live schema's tables, column definitions, foreign keys, and indexes."
)
print(
    "NOTE: this proves structural compatibility only; it does not prove the recovered SQL "
    "is identical to the original SQL applied in production."
)
