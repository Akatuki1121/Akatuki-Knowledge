from pathlib import Path
import re
import sqlite3
import textwrap
from datetime import datetime, timedelta

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "background-task-store.mjs"
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "0011_agent_tasks.sql"
BUDGET_MIGRATION = ROOT / "migrations" / "0017_cloudflare_free_workflow_budget.sql"

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(SCHEMA.read_text(encoding="utf-8"))
connection.executescript(MIGRATION.read_text(encoding="utf-8"))
connection.executescript(BUDGET_MIGRATION.read_text(encoding="utf-8"))

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

# Regression: execute the real enqueue SQL batch against the former task-count cap
# and the Cloudflare Free Workflow-step budget. No simplified guard is substituted.
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
def enqueue(day, task_id):
    now = day + " 12:00:00"
    deadline = (datetime.strptime(day, "%Y-%m-%d") + timedelta(hours=20)).strftime("%Y-%m-%d %H:%M:%S")
    params = [
        (task_id, None, "test", "{}", 4, 9_007_199_254_740_991, 9_007_199_254_740_991, now, now, deadline, now, None, None, now),
        (day, now),
        (day, task_id, day),
        (task_id, day, day),
        (now, day, task_id, day),
        (task_id, day),
        (now, task_id, task_id),
    ]
    for statement, bindings in zip(enqueue_statements, params):
        connection.execute(statement, bindings)
    row = connection.execute(
        "SELECT status, budget_reserved FROM agent_tasks WHERE task_id = ?", (task_id,)
    ).fetchone()
    if row and row[1] != 1 and row[0] == "queued":
        next_day = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1))
        retry_at = next_day.replace(hour=0, minute=1, second=0).strftime("%Y-%m-%d %H:%M:%S")
        next_deadline = next_day.replace(hour=1, minute=1, second=0).strftime("%Y-%m-%d %H:%M:%S")
        connection.execute(
            """UPDATE agent_tasks
               SET next_attempt_at = ?,
                   deadline_at = CASE WHEN deadline_at < ? THEN ? ELSE deadline_at END,
                   updated_at = ?
               WHERE task_id = ? AND budget_reserved = 0 AND status = 'queued'""",
            (retry_at, next_deadline, next_deadline, now, task_id),
        )
    return connection.execute(
        "SELECT status, budget_reserved, stop_reason FROM agent_tasks WHERE task_id = ?", (task_id,)
    ).fetchone()

# A former 60-task count must no longer reject work while Cloudflare step capacity remains.
connection.execute(
    "INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at) VALUES (?, ?, ?, ?)",
    ("2026-10-21", 60, 1920, "2026-10-21 00:00:00"),
)
assert enqueue("2026-10-21", "over-former-task-cap") == ("queued", 1, None)
counters = connection.execute(
    "SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?",
    ("2026-10-21",),
).fetchone()
assert counters == (61, 1952), f"Former task-count cap must not block admission: {counters}"

# 2,700 reserved steps leaves 300 of Cloudflare's 3,000 daily Free steps unallocated.
connection.execute(
    "INSERT INTO agent_task_daily_budget (budget_day, tasks_reserved, workflow_steps_reserved, updated_at) VALUES (?, ?, ?, ?)",
    ("2026-10-22", 84, 2688, "2026-10-22 00:00:00"),
)
assert enqueue("2026-10-22", "over-step-budget") == ("queued", 0, None)
reservation = connection.execute(
    "SELECT counted FROM agent_task_budget_reservations WHERE task_id = ?", ("over-step-budget",)
).fetchone()
deferred = connection.execute(
    "SELECT next_attempt_at, deadline_at FROM agent_tasks WHERE task_id = ?", ("over-step-budget",)
).fetchone()
assert deferred == ("2026-10-23 00:01:00", "2026-10-23 01:01:00"), (
    f"Workflow capacity exhaustion must defer, not fail, the task: {deferred}"
)
assert reservation is None, f"Deferred task must not reserve unavailable Workflow steps: {reservation}"
counters = connection.execute(
    "SELECT tasks_reserved, workflow_steps_reserved FROM agent_task_daily_budget WHERE budget_day = ?",
    ("2026-10-22",),
).fetchone()
assert counters == (84, 2688), f"Deferred task must not increase daily counters: {counters}"

print("Background task store SQL compilation and Cloudflare Free step-budget queue deferral tests passed.")
