#!/usr/bin/env python3
"""Static SQL compatibility check against the captured D1 schema; never connects to Cloudflare."""
import re
import sqlite3
from pathlib import Path

SOURCES = [Path("src/index.js"), Path("src/agent-memory.mjs")]
SCHEMA = Path("schema-snapshots/live-d1-schema-2026-10-19.sql")
PENDING_MIGRATIONS = [
    Path("migrations/0009_yaos_sync_jobs.sql"),
    Path("migrations/0010_bot_organization_candidates.sql"),
    Path("migrations/0011_agent_tasks.sql"),
    Path("migrations/0012_bot_ai_permission_previews.sql"),
    Path("migrations/pending/0013_agent_memory_metadata.sql"),
]
CALL_RE = re.compile(
    r"\.(?:prepare|exec|batch)\s*\(\s*(?:"
    r'"((?:\\.|[^"\\])*)"'
    r"|'((?:\\.|[^'\\])*)'"
    r"|\x60((?:\\.|[^\x60\\])*)\x60"
    r")",
    re.DOTALL,
)
SQL_WORD = re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE)\b", re.IGNORECASE)
TABLE_TOKEN = "$" + "{table}"
PATH_COLUMN_TOKEN = "$" + "{pathColumn}"
CONDITIONS_TOKEN = "$" + "{conditions}"
ID_FILTER_TOKEN = "$" + "{idFilter}"
SOURCE_EXPR = '$' + '{table === "notes" ? "obsidian" : "telegram"}'


def decode_js_string(value: str) -> str:
    return value.replace(r"\n", "\n").replace(r"\r", "\r").replace(r"\t", "\t").replace(r"\"", '"').replace(r"\'", "'").replace(r"\\", "\\")


def variants(query: str):
    if CONDITIONS_TOKEN in query:
        query = query.replace(CONDITIONS_TOKEN, "1 = 1")
    if ID_FILTER_TOKEN in query:
        query = query.replace(ID_FILTER_TOKEN, "")
    if SOURCE_EXPR in query:
        query = query.replace(SOURCE_EXPR, "obsidian")
    if TABLE_TOKEN in query:
        for table in ("notes", "telegram_notes"):
            path_column = "path" if table == "notes" else "NULL AS path"
            yield query.replace(TABLE_TOKEN, table).replace(PATH_COLUMN_TOKEN, path_column)
        return
    if PATH_COLUMN_TOKEN in query:
        yield query.replace(PATH_COLUMN_TOKEN, "path")
        yield query.replace(PATH_COLUMN_TOKEN, "NULL AS path")
        return
    if "$" + "{" in query:
        return
    yield query


db = sqlite3.connect(":memory:")
db.executescript(SCHEMA.read_text(encoding="utf-8"))
# Validate Worker SQL against the captured live schema plus additive pending migrations.
for migration in PENDING_MIGRATIONS:
    db.executescript(migration.read_text(encoding="utf-8"))
sources = [path.read_text(encoding="utf-8") for path in SOURCES]
checked = 0
skipped_dynamic = 0
failures = []
seen = set()

for source in sources:
    for match in CALL_RE.finditer(source):
        raw = next(group for group in match.groups() if group is not None)
        query = decode_js_string(raw).strip()
        if not SQL_WORD.search(query):
            continue
        # A string literal continued with "+" is a dynamically built statement. The only
        # supported shape is a trailing placeholder list: "... IN (" + placeholders + ")".
        if source[match.end():].lstrip().startswith("+"):
            if re.search(r"\bIN\s*\($", query, re.IGNORECASE):
                query += "?)"
            else:
                skipped_dynamic += 1
                continue
        query_variants = list(variants(query))
        if not query_variants:
            skipped_dynamic += 1
            continue
        for candidate in query_variants:
            normalized = re.sub(r"\s+", " ", candidate).strip()
            if normalized in seen:
                continue
            seen.add(normalized)
            try:
                parameter_tokens = re.findall(r"\?(\d*)", candidate)
                numbered = [int(token) for token in parameter_tokens if token]
                parameter_count = max(numbered) if numbered else len(parameter_tokens)
                db.execute("EXPLAIN " + candidate, (None,) * parameter_count).fetchall()
                checked += 1
            except sqlite3.Error as exc:
                failures.append((str(exc), normalized[:260]))

if failures:
    print(f"FAIL: {len(failures)} SQL statement variant(s) failed; {checked} passed; {skipped_dynamic} dynamic statement(s) skipped.")
    for error, query in failures:
        print(f"- {error}: {query}")
    raise SystemExit(1)

print(f"PASS: {checked} SQL statement variant(s) compiled against the captured schema; {skipped_dynamic} unrecognized dynamic statement(s) skipped.")
