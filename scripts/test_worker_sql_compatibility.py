#!/usr/bin/env python3
"""Static SQL compatibility check against the captured D1 schema; never connects to Cloudflare."""
import re
import sqlite3
from pathlib import Path

SOURCE = Path("src/index.js")
SCHEMA = Path("schema-snapshots/live-d1-schema-2026-10-19.sql")
PENDING_MIGRATION = Path("migrations/pending/0008_yaos_sync_jobs.sql")
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
# Validate Worker SQL against the captured live schema plus the proposed additive sync migration.
db.executescript(PENDING_MIGRATION.read_text(encoding="utf-8"))
source = SOURCE.read_text(encoding="utf-8")
checked = 0
skipped_dynamic = 0
failures = []
seen = set()

for match in CALL_RE.finditer(source):
    raw = next(group for group in match.groups() if group is not None)
    query = decode_js_string(raw).strip()
    if not SQL_WORD.search(query):
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
