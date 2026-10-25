from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "pending" / "0015_intent_classifier_counters.sql"
SOURCE = ROOT / "src" / "intent-classifier.mjs"

migration_sql = MIGRATION.read_text(encoding="utf-8")
source = SOURCE.read_text(encoding="utf-8")


def js_string_block(name):
    match = re.search(name + r"\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)", source)
    assert match, f"{name} not found in intent-classifier.mjs"
    return re.findall(r'"([^"]+)"', match.group(1))


# The counter vocabularies the code can emit (src/intent-classifier.mjs).
code_routes = js_string_block("INTENT_CLASSIFIER_ROUTES") + ["abstain", "tier0"]
code_sources = ["tier0", "shadow"] + js_string_block("INTENT_CLASSIFIER_ABSTAIN_REASONS")

# The vocabularies the migration's CHECK constraints allow.
route_check = re.search(r"CHECK \(route IN \(([^)]*)\)\)", migration_sql)
source_check = re.search(r"CHECK \(source IN \(([^)]*)\)\)", migration_sql)
assert route_check and source_check, "Migration is missing route/source CHECK constraints"
sql_routes = re.findall(r"'([^']+)'", route_check.group(1))
sql_sources = re.findall(r"'([^']+)'", source_check.group(1))
assert sql_routes == code_routes, f"Route vocabulary drift: SQL {sql_routes} != code {code_routes}"
assert sql_sources == code_sources, f"Source vocabulary drift: SQL {sql_sources} != code {code_sources}"

connection = sqlite3.connect(":memory:")
connection.executescript(migration_sql)

columns = {row[1] for row in connection.execute("PRAGMA table_info(intent_classifier_counters)")}
required = {"day", "route", "source", "count"}
assert required <= columns, f"Missing counter columns: {required - columns}"

primary_key = {
    row[1]
    for row in connection.execute("PRAGMA table_info(intent_classifier_counters)")
    if row[5] > 0
}
assert primary_key == {"day", "route", "source"}, f"Unexpected primary key: {primary_key}"

indexes = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='intent_classifier_counters'"
    )
}
assert "idx_intent_classifier_counters_day" in indexes, "Day index is missing"

# The exact SQL statements the module issues against this table.
statements = [
    match.group(1)
    for match in re.finditer(r'db\.prepare\(\s*"([^"]*intent_classifier_counters[^"]*)"', source)
]
assert len(statements) == 2, f"Expected 2 counter SQL statements, found {len(statements)}"
insert_sql = next(s for s in statements if s.startswith("INSERT"))
select_sql = next(s for s in statements if s.startswith("SELECT"))
for statement in statements:
    try:
        connection.execute("EXPLAIN " + statement, [None] * statement.count("?"))
    except Exception as error:
        raise AssertionError(f"Counter SQL failed SQLite compilation: {error}\n{statement}") from error

# Every vocabulary value the code can emit must be storable, and the
# ON CONFLICT upsert must accumulate instead of duplicating rows.
for route in code_routes:
    for src in code_sources:
        connection.execute(insert_sql, ("2026-10-25", route, src))
connection.execute(insert_sql, ("2026-10-25", "conversation", "shadow"))
connection.execute(insert_sql, ("2026-10-25", "conversation", "shadow"))
row = connection.execute(
    "SELECT count FROM intent_classifier_counters WHERE day = '2026-10-25' AND route = 'conversation' AND source = 'shadow'"
).fetchone()
assert row[0] == 3, f"Upsert did not accumulate: {row[0]}"
total_rows = connection.execute("SELECT COUNT(*) FROM intent_classifier_counters").fetchone()[0]
assert total_rows == len(code_routes) * len(code_sources), f"Unexpected row count: {total_rows}"

# The daily-execution reader must compile and return a number.
total = connection.execute(select_sql, ("2026-10-25",)).fetchone()[0]
assert total > 0, "Daily execution total should be positive after inserts"

# Out-of-vocabulary values must be rejected by the CHECK constraints.
for column, bad_value in (("route", "note_add"), ("source", "free_text_reason")):
    values = {"day": "2026-10-25", "route": "conversation", "source": "shadow"}
    values[column] = bad_value
    try:
        connection.execute(
            "INSERT INTO intent_classifier_counters (day, route, source, count) VALUES (?, ?, ?, 1)",
            (values["day"], values["route"], values["source"]),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError(f"Invalid counter {column} value was accepted: {bad_value}")

# Negative counts must be rejected.
try:
    connection.execute(
        "INSERT INTO intent_classifier_counters (day, route, source, count) VALUES ('2026-10-25', 'tier0', 'tier0', -1)"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Negative counter count was accepted")

print("Intent classifier counters migration (0015) checks passed.")
