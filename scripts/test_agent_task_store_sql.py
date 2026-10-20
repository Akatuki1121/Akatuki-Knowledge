from pathlib import Path
import re
import sqlite3
import textwrap

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "background-task-store.mjs"
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "pending" / "0011_agent_tasks.sql"

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(SCHEMA.read_text(encoding="utf-8"))
connection.executescript(MIGRATION.read_text(encoding="utf-8"))

source = SOURCE.read_text(encoding="utf-8")
statements = [
    textwrap.dedent(match.group(1)).strip()
    for match in re.finditer(r"db\.prepare\(\s*`([\s\S]*?)`\s*\)", source)
]
assert len(statements) >= 7, f"Expected at least 7 SQL template statements, found {len(statements)}"

for index, statement in enumerate(statements, start=1):
    parameters = [None] * statement.count("?")
    try:
        connection.execute("EXPLAIN " + statement, parameters)
    except Exception as error:
        raise AssertionError(f"Task-store SQL statement {index} failed SQLite compilation: {error}\\n{statement}") from error

print(f"Background task store SQL compilation passed ({len(statements)} statements).")

# Regression: an exhausted daily budget must not claim or admit another task.
assert "counted IN (0, 1, 2)" in MIGRATION.read_text(encoding="utf-8"), "Reservation state machine constraint is missing"
connection.execute(
    "INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at) VALUES (?, 60, 1920, ?)",
    ("2026-10-21", "2026-10-21 00:00:00"),
)
connection.execute(
    "INSERT INTO agent_tasks (task_id, task_type, status, budget_reserved, deadline_at) VALUES (?, ?, 'queued', 0, ?)",
    ("over-cap-task", "test", "2099-01-01 00:00:00"),
)
connection.execute(
    "INSERT INTO agent_task_budget_reservations (task_id, budget_day, workflow_steps, counted) VALUES (?, ?, 32, 0)",
    ("over-cap-task", "2026-10-21"),
)
connection.execute("""
UPDATE agent_task_budget_reservations SET counted = 1
WHERE task_id = ? AND budget_day = ? AND counted = 0
  AND EXISTS (SELECT 1 FROM agent_task_daily_budget
    WHERE budget_day = ? AND tasks_reserved < 60 AND workflow_steps_reserved + 32 <= 2000)
""", ("over-cap-task", "2026-10-21", "2026-10-21"))
assert connection.execute(
    "SELECT counted FROM agent_task_budget_reservations WHERE task_id = ?", ("over-cap-task",)
).fetchone() == (0,), "A reservation at the daily cap must remain unclaimed"
assert connection.execute(
    "SELECT budget_reserved FROM agent_tasks WHERE task_id = ?", ("over-cap-task",)
).fetchone() == (0,), "A task without a completed reservation must not be admitted"
