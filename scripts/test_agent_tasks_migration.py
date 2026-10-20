from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "pending" / "0011_agent_tasks.sql"

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(SCHEMA.read_text(encoding="utf-8"))
connection.executescript(MIGRATION.read_text(encoding="utf-8"))

columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_tasks)")}
required = {
    "task_id", "idempotency_key", "task_type", "status", "payload_json",
    "checkpoint_json", "attempts", "max_attempts", "ai_calls_used", "max_ai_calls",
    "ai_tokens_used", "max_ai_tokens", "created_at", "updated_at", "deadline_at",
    "next_attempt_at", "lease_token", "lease_expires_at", "last_error_class",
    "last_error", "stop_reason",
}
assert required <= columns, f"Missing agent task columns: {required - columns}"

indexes = {
    row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_tasks'"
    )
}
assert {
    "idx_agent_tasks_ready",
    "idx_agent_tasks_lease",
    "idx_agent_tasks_deadline",
} <= indexes, "One or more task indexes are missing"

connection.execute(
    "INSERT INTO agent_tasks (task_id, task_type, deadline_at) VALUES ('task-1', 'test', '2099-01-01 00:00:00')"
)
try:
    connection.execute(
        "INSERT INTO agent_tasks (task_id, task_type, deadline_at) VALUES ('task-1', 'test', '2099-01-01 00:00:00')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Task ID primary-key constraint is not enforced")

try:
    connection.execute(
        "INSERT INTO agent_tasks (task_id, task_type, status, deadline_at) "
        "VALUES ('task-invalid', 'test', 'retrying-forever', '2099-01-01 00:00:00')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Task status CHECK constraint is not enforced")

try:
    connection.execute(
        "INSERT INTO agent_tasks (task_id, task_type, attempts, deadline_at) "
        "VALUES ('task-invalid-attempts', 'test', -1, '2099-01-01 00:00:00')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Negative attempts were not rejected")

assert not list(connection.execute("PRAGMA foreign_key_check"))
print("Pending agent task migration passes isolated SQLite schema and constraint checks.")
