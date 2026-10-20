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

# Regression: execute the real enqueue SQL batch at both independent daily caps.
# This tests the production statements, rather than a simplified copy of the guard.
enqueue_start = source.index("export async function enqueueAgentTask")
enqueue_end = source.index("export async function claimNextAgentTask", enqueue_start)
enqueue_source = source[enqueue_start:enqueue_end]
# Inspect only the statements passed to db.batch(); the enqueue function also
# contains a separate fail-closed UPDATE after the batch, which is not an
# admission-batch statement and is exercised separately below.
batch_start = enqueue_source.index("const statements = [")
batch_end = enqueue_source.index("const results = await db.batch(statements);", batch_start)
batch_source = enqueue_source[batch_start:batch_end]
enqueue_statements = [
    textwrap.dedent(match.group(1)).strip()
    for match in re.finditer(r"db\.prepare\(\s*`([\s\S]*?)`\s*\)", batch_source)
]
assert len(enqueue_statements) == 7, f"Expected all seven admission-batch statements, found {len(enqueue_statements)}"
def assert_budget_cap_rejects_task(day, task_cap, step_cap):
    connection.execute(
        "INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at) VALUES (?, ?, ?, ?)",
        (day, task_cap, step_cap, day + " 00:00:00"),
    )
    now = day + " 12:00:00"
    deadline = "2099-01-01 00:00:00"
    task_id = "over-cap-" + day + "-" + str(task_cap) + "-" + str(step_cap)
    params = [
        (task_id, None, "test", "{}", 4, 20, 40000, now, now, deadline, now, None, None, now),
        (day, now),
        (day, task_id, day),
        (task_id, day, day),
        (now, day, task_id, day),
        (task_id, day),
        (now, task_id, task_id),
    ]
    for statement, bindings in zip(enqueue_statements, params):
        connection.execute(statement, bindings)
    connection.execute("""
        UPDATE agent_tasks SET status = 'failed',
            stop_reason = 'daily_workflow_budget_exhausted',
            completed_at = ?, updated_at = ?
        WHERE task_id = ? AND budget_reserved = 0 AND status = 'queued'
    """, (now, now, task_id))
    row = connection.execute(
        "SELECT status, budget_reserved, stop_reason FROM agent_tasks WHERE task_id = ?", (task_id,)
    ).fetchone()
    assert row == ("failed", 0, "daily_workflow_budget_exhausted"), f"Task at daily cap must fail closed: {row}"
    reservation = connection.execute(
        "SELECT counted FROM agent_task_budget_reservations WHERE task_id = ?", (task_id,)
    ).fetchone()
    assert reservation is None, f"Capacity rejection must not create a reservation: {reservation}"
    counters = connection.execute(
        "SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?",
        (day,),
    ).fetchone()
    assert counters == (task_cap, step_cap), f"Rejected task must not increase daily counters: {counters}"

assert_budget_cap_rejects_task("2026-10-21", 60, 1920)
assert_budget_cap_rejects_task("2026-10-22", 59, 1984)
