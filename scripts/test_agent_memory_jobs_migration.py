from pathlib import Path
import re
import sqlite3
import textwrap

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0014_agent_memory_jobs.sql"

connection = sqlite3.connect(":memory:")
connection.executescript(MIGRATION.read_text(encoding="utf-8"))

columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_memory_jobs)")}
required = {
    "job_id", "chat_id", "message_id", "message_text", "status", "attempts",
    "max_attempts", "next_attempt_at", "lease_expires_at", "last_error_class",
    "created_at", "updated_at", "completed_at",
}
assert required <= columns, f"Missing queue columns: {required - columns}"

indexes = {
    row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_memory_jobs'"
    )
}
assert {"idx_agent_memory_jobs_ready", "idx_agent_memory_jobs_lease"} <= indexes

connection.execute(
    "INSERT INTO agent_memory_jobs (chat_id, message_id, message_text) VALUES ('c', 'm', 'safe text')"
)
try:
    connection.execute(
        "INSERT INTO agent_memory_jobs (chat_id, message_id, message_text) VALUES ('c', 'm', 'duplicate')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate chat/message jobs were not rejected")

for status in ("queued", "processing", "completed", "failed", "discarded"):
    connection.execute(
        "INSERT INTO agent_memory_jobs (chat_id, message_id, message_text, status) VALUES (?, ?, 'text', ?)",
        ("c-" + status, "m-" + status, status),
    )
try:
    connection.execute(
        "INSERT INTO agent_memory_jobs (chat_id, message_id, message_text, status) VALUES ('bad', 'status', 'text', 'retrying')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Invalid memory-job status was accepted")

SOURCE = ROOT / "src" / "agent-memory-queue.mjs"
source = SOURCE.read_text(encoding="utf-8")
statements = [
    textwrap.dedent(match.group(1)).strip()
    for match in re.finditer(r"db\\.prepare\\(\\s*`([\\s\\S]*?)`\\s*\\)", source)
]
assert len(statements) >= 5, f"Expected queue SQL statements, found {len(statements)}"
for index, statement in enumerate(statements, start=1):
    try:
        connection.execute("EXPLAIN " + statement, [None] * statement.count("?"))
    except Exception as error:
        raise AssertionError(f"Memory queue SQL statement {index} failed SQLite compilation: {error}\\n{statement}") from error

print("Agent memory jobs migration checks passed.")
