from pathlib import Path
import json
import re
import sqlite3
import tempfile
import textwrap
import threading

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "background-task-store.mjs"
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATION = ROOT / "migrations" / "0011_agent_tasks.sql"

source = SOURCE.read_text(encoding="utf-8")
statements = [
    textwrap.dedent(match.group(1)).strip()
    for match in re.finditer(r"db\.prepare\(\s*`([\s\S]*?)`\s*\)", source)
]


def statement_containing(*fragments):
    matches = [sql for sql in statements if all(fragment in sql for fragment in fragments)]
    assert len(matches) == 1, f"Expected one production SQL statement containing {fragments}, found {len(matches)}"
    return matches[0]


claim_sql = statement_containing("SET status = 'running'", "RETURNING *")
checkpoint_sql = statement_containing("SET checkpoint_json = ?", "WHERE task_id = ?")
complete_sql = statement_containing("SET status = 'succeeded'", "completed_at = ?")
cancel_sql = statement_containing("SET status = 'cancelled'", "WHERE task_id = ? AND notify_chat_id = ?", "RETURNING task_id")
expire_sql = statement_containing(
    "task_deadline_exceeded",
    "WHERE status IN ('queued', 'waiting', 'running')",
)

NOW = "2026-10-22 12:00:00"
FUTURE = "2099-01-01 00:00:00"
CHECKPOINT = {"stage": "context_ready", "contextNotes": [{"id": "note-1"}]}


def create_database(connection):
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))


def insert_task(connection, task_id, *, status="queued", deadline=FUTURE, checkpoint="{}"):
    connection.execute(
        """INSERT INTO agent_tasks
           (task_id, task_type, status, budget_reserved, checkpoint_json, deadline_at, next_attempt_at)
           VALUES (?, 'knowledge_query', ?, 1, ?, ?, ?)""",
        (task_id, status, checkpoint, deadline, NOW),
    )


def claim(connection, task_id, token, now=NOW):
    return connection.execute(
        claim_sql,
        (token, now, 60, now, now, now, now, now, task_id, task_id),
    ).fetchone()


def initialize(connection):
    create_database(connection)
    columns = [column[1] for column in connection.execute("PRAGMA table_info(agent_tasks)")]
    return {name: index for index, name in enumerate(columns)}


connection = sqlite3.connect(":memory:")
column_index = initialize(connection)
insert_task(connection, "recoverable")

first_claim = claim(connection, "recoverable", "lease-old")
assert first_claim is not None and first_claim[column_index["attempts"]] == 1
assert claim(connection, "recoverable", "lease-duplicate") is None, "An active lease must exclude duplicate delivery"

checkpoint_json = json.dumps(CHECKPOINT, separators=(",", ":"))
saved = connection.execute(
    checkpoint_sql,
    (checkpoint_json, NOW, "recoverable", "lease-old", NOW, NOW),
).rowcount
assert saved == 1, "The current lease must be able to persist its checkpoint"

# Simulate forced process termination after checkpoint persistence and expiry of
# the abandoned lease; the next executor must resume without losing that state.
connection.execute(
    "UPDATE agent_tasks SET lease_expires_at = ? WHERE task_id = ?",
    ("2026-10-22 11:59:59", "recoverable"),
)
recovered = claim(connection, "recoverable", "lease-new")
assert recovered is not None and recovered[column_index["attempts"]] == 2
assert json.loads(recovered[column_index["checkpoint_json"]]) == CHECKPOINT

stale_write = connection.execute(
    checkpoint_sql,
    (json.dumps({"stage": "completed"}), NOW, "recoverable", "lease-old", NOW, NOW),
).rowcount
assert stale_write == 0, "A stale executor must not overwrite a recovered checkpoint"
stale_completion = connection.execute(
    complete_sql,
    (NOW, NOW, "recoverable", "lease-old", NOW, NOW),
).rowcount
assert stale_completion == 0, "A stale executor must not complete a recovered task"

completed = connection.execute(
    complete_sql,
    (NOW, NOW, "recoverable", "lease-new", NOW, NOW),
).rowcount
assert completed == 1
duplicate_completion = connection.execute(
    complete_sql,
    (NOW, NOW, "recoverable", "lease-new", NOW, NOW),
).rowcount
assert duplicate_completion == 0, "Terminal completion must be idempotently rejected"
assert claim(connection, "recoverable", "lease-after-complete") is None

# Cancellation is scoped to the originating chat, atomically terminalizes an
# active task, clears its lease, and blocks stale checkpoint/completion writes.
insert_task(connection, "cancel-active", status="running")
connection.execute(
    "UPDATE agent_tasks SET notify_chat_id = ?, lease_token = ?, lease_expires_at = ? WHERE task_id = ?",
    ("chat-1", "cancel-lease", FUTURE, "cancel-active"),
)
cancelled = connection.execute(
    cancel_sql, (NOW, NOW, "cancel-active", "chat-1")
).fetchone()
assert cancelled == ("cancel-active",), "The owning chat must be able to cancel an active task"
cancelled_state = connection.execute(
    "SELECT status, stop_reason, lease_token, notification_status FROM agent_tasks WHERE task_id = ?",
    ("cancel-active",),
).fetchone()
assert cancelled_state == ("cancelled", "user_cancelled", None, "sent"), (
    f"Cancellation must clear execution lease and suppress duplicate terminal notifications: {cancelled_state}"
)
assert connection.execute(
    complete_sql, (NOW, NOW, "cancel-active", "cancel-lease", NOW, NOW)
).rowcount == 0, "A cancelled task must reject stale completion"
assert connection.execute(
    cancel_sql, (NOW, NOW, "cancel-active", "another-chat")
).fetchone() is None, "A different chat must not cancel another chat's task"


insert_task(
    connection,
    "expired",
    status="running",
    deadline="2026-10-22 11:59:00",
    checkpoint=checkpoint_json,
)
connection.execute(
    "UPDATE agent_tasks SET attempts = 1, lease_token = 'expired-lease', lease_expires_at = ? WHERE task_id = ?",
    ("2026-10-22 11:58:00", "expired"),
)
connection.execute(expire_sql, (NOW, NOW, NOW, NOW, NOW, NOW, NOW))
expired = connection.execute(
    "SELECT status, stop_reason, checkpoint_json FROM agent_tasks WHERE task_id = 'expired'"
).fetchone()
assert expired == ("failed", "task_deadline_exceeded", checkpoint_json), (
    "Deadline expiry must stop execution without deleting its persisted checkpoint"
)
connection.close()

# Exercise two genuinely concurrent SQLite connections against the same
# production claim statement. The atomic UPDATE ... RETURNING must grant one
# lease only, not duplicate the same task to both executors.
with tempfile.TemporaryDirectory() as temporary_directory:
    database_path = Path(temporary_directory) / "agent-task-recovery.sqlite"
    setup = sqlite3.connect(database_path)
    column_index = initialize(setup)
    insert_task(setup, "contended")
    setup.commit()
    setup.close()

    barrier = threading.Barrier(2)
    outcomes = []
    errors = []

    def concurrent_claim(token):
        db = sqlite3.connect(database_path, timeout=5)
        try:
            barrier.wait(timeout=5)
            row = claim(db, "contended", token)
            outcomes.append(row[column_index["task_id"]] if row else None)
            db.commit()
        except Exception as error:
            errors.append(error)
        finally:
            db.close()

    threads = [
        threading.Thread(target=concurrent_claim, args=("contender-a",)),
        threading.Thread(target=concurrent_claim, args=("contender-b",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive(), "Concurrent claim test did not finish"

    assert not errors, f"Concurrent claim raised an SQLite error: {errors}"
    assert outcomes.count("contended") == 1 and outcomes.count(None) == 1, (
        f"Exactly one concurrent executor must claim the task: {outcomes}"
    )

print("Background task recovery tests passed: checkpoint resume, stale lease fencing, deadline stop, duplicate delivery, and concurrent claim.")
