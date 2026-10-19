from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "pending" / "0008_yaos_sync_jobs.sql"

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(SCHEMA.read_text(encoding="utf-8"))

before = {row[1] for row in connection.execute("PRAGMA table_info(notes)")}
assert "sync_uuid" not in before, "Snapshot already contains the proposed sync_uuid column"
assert connection.execute(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='yaos_sync_jobs'"
).fetchone() is None, "Snapshot already contains the proposed outbox table"

# This is an isolated in-memory test against the captured schema, not production D1.
connection.executescript(MIGRATION.read_text(encoding="utf-8"))

after = {row[1] for row in connection.execute("PRAGMA table_info(notes)")}
assert "sync_uuid" in after, "Migration did not add notes.sync_uuid"

job_columns = {row[1] for row in connection.execute("PRAGMA table_info(yaos_sync_jobs)")}
required_columns = {
    "job_id", "event_id", "entity_type", "entity_id", "operation", "payload_json",
    "status", "attempts", "next_attempt_at", "lease_expires_at", "last_error",
    "created_at", "updated_at", "sent_at",
}
assert required_columns <= job_columns, f"Missing outbox columns: {required_columns - job_columns}"

indexes = {
    row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='yaos_sync_jobs'"
    )
}
assert {
    "idx_yaos_sync_jobs_ready",
    "idx_yaos_sync_jobs_entity",
    "idx_yaos_sync_jobs_lease",
} <= indexes, "One or more outbox indexes are missing"

connection.execute(
    "INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json) "
    "VALUES ('test-event', 'notes', 'test-note', 'upsert', '{}')"
)
try:
    connection.execute(
        "INSERT INTO yaos_sync_jobs (event_id, entity_type, entity_id, operation, payload_json) "
        "VALUES ('test-event', 'notes', 'test-note-2', 'upsert', '{}')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Outbox event_id uniqueness constraint is not enforced")

foreign_key_errors = list(connection.execute("PRAGMA foreign_key_check"))
assert not foreign_key_errors, f"Foreign-key violations after migration: {foreign_key_errors}"

print("Pending outbox migration applies cleanly to the captured schema in isolated SQLite.")
