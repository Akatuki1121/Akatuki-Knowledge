from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "0009_yaos_sync_jobs.sql"

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

print("Outbox migration (0009) applies cleanly to the captured schema in isolated SQLite.")


# Pending migrations are intentionally kept outside the production migration path.
PENDING = ROOT / "migrations" / "pending"
EXPECTED_PENDING = {
    "0016_workers_ai_daily_usage.sql",
    "0017_cloudflare_free_workflow_budget.sql",
    "0018_workers_ai_failed_calls.sql",
}
pending_names = {path.name for path in PENDING.glob("*.sql")}
assert EXPECTED_PENDING <= pending_names, f"Missing pending budget migrations: {EXPECTED_PENDING - pending_names}"

# Validate the Workers AI usage table and its follow-up failure counter migration.
budget_db = sqlite3.connect(":memory:")
budget_db.executescript((PENDING / "0016_workers_ai_daily_usage.sql").read_text(encoding="utf-8"))
budget_db.executescript((PENDING / "0018_workers_ai_failed_calls.sql").read_text(encoding="utf-8"))
columns = {row[1] for row in budget_db.execute("PRAGMA table_info(workers_ai_daily_usage)")}
assert {"usage_day", "reserved_neurons", "actual_neurons", "calls_completed", "calls_failed", "updated_at"} <= columns
budget_db.close()

print("Pending budget migrations are present and the Workers AI migration chain validates in isolated SQLite.")
