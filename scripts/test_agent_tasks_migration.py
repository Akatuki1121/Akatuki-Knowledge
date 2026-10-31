from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "0011_agent_tasks.sql"
ATTENTION_MIGRATION = ROOT / "migrations" / "0019_agent_task_attention_and_reassessment.sql"

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(SCHEMA.read_text(encoding="utf-8"))
connection.executescript(MIGRATION.read_text(encoding="utf-8"))
connection.executescript(ATTENTION_MIGRATION.read_text(encoding="utf-8"))

columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_tasks)")}
required = {
    "task_id", "idempotency_key", "task_type", "status", "payload_json",
    "checkpoint_json", "attempts", "max_attempts", "ai_calls_used", "max_ai_calls",
    "ai_tokens_used", "max_ai_tokens", "created_at", "updated_at", "deadline_at",
    "next_attempt_at", "lease_token", "lease_expires_at", "last_error_class",
    "last_error", "stop_reason", "notify_chat_id", "notification_status",
    "notification_attempts", "notification_next_attempt_at",
    "notification_lease_expires_at", "notification_last_error_class", "retry_policy_version",
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

try:
    connection.execute(
        "INSERT INTO agent_tasks (task_id, task_type, status, notification_status, deadline_at) "
        "VALUES ('task-invalid-notification', 'test', 'queued', 'retrying-forever', '2099-01-01 00:00:00')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Invalid notification status was not rejected")

connection.execute("INSERT INTO agent_tasks (task_id, task_type, status, deadline_at) VALUES ('task-needs-attention', 'test', 'needs_attention', '2099-01-01 00:00:00')")
assert connection.execute("SELECT status, retry_policy_version FROM agent_tasks WHERE task_id = 'task-needs-attention'").fetchone() == ("needs_attention", 0)

tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
assert "agent_task_daily_budget" in tables, "Daily Workflow budget table is missing"

reserve_sql = """
INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at)
VALUES (?, 1, 32, ?)
ON CONFLICT(budget_day) DO UPDATE SET
  tasks_reserved = tasks_reserved + 1,
  workflow_steps_reserved = workflow_steps_reserved + 32,
  updated_at = excluded.updated_at
WHERE tasks_reserved < 60 AND workflow_steps_reserved + 32 <= 2000
RETURNING tasks_reserved, workflow_steps_reserved
"""
connection.execute(
    "INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at) VALUES (?, 59, 1888, ?)",
    ("2026-10-20", "2026-10-20 00:00:00"),
)
reserved = connection.execute(reserve_sql, ("2026-10-20", "2026-10-20 12:00:00")).fetchone()
assert reserved == (60, 1920), f"Daily budget reservation mismatch: {reserved}"
blocked = connection.execute(reserve_sql, ("2026-10-20", "2026-10-20 12:01:00")).fetchone()
assert blocked is None, "Daily Workflow budget did not stop at the hard cap"

assert not list(connection.execute("PRAGMA foreign_key_check"))
print("Pending agent task migration passes isolated SQLite schema and constraint checks.")
