#!/usr/bin/env python3
"""Regression test for the GET /api/notes prefix filter (listNotes).

The work board reads notes through the list API, whose only window was
"newest 100 by updated_at". Improvement memos that had not been edited
recently fell outside that window and were invisible to the board even
though they existed. listNotes now accepts an optional `prefix` query
parameter: a literal path prefix (LIKE wildcards in the caller's value
are escaped, so `%` and `_` never widen the match), and telegram notes,
which have no path, are excluded whenever a prefix is given.

This test extracts the actual SQL template from src/index.js, expands it
exactly as the Worker does (the template literal's escaped backslash
becomes a single backslash),
and runs it against production-shaped fixtures: 120 recent notes that
fill the limit=100 window, 3 older improvement memos under one folder,
telegram notes, a deleted note, and folders whose names contain the LIKE
wildcards `_` and `%` next to look-alike folders without them.
"""
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "index.js"
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"

RECENT_COUNT = 120
MEMO_PREFIX = "Notes/改善メモ/"
MEMO_COUNT = 3


def fail(message):
    print(f"FAIL: {message}")
    raise SystemExit(1)


def extract_list_sql():
    source = SOURCE.read_text(encoding="utf-8")
    anchor = source.find("async function listNotes")
    if anchor < 0:
        fail("listNotes not found in src/index.js")
    match = re.search(r"env\.DB\.prepare\(`([\s\S]*?)`\)", source[anchor:])
    if not match:
        fail("list SQL template not found in listNotes")
    sql = match.group(1).replace("\\\\", "\\")
    if "${" in sql:
        fail("unexpanded placeholder left in extracted list SQL")
    return sql


def like_pattern(prefix):
    # Mirror of the escaping in listNotes: prefix.replace(/[\\%_]/g, ...)
    if not prefix:
        return None
    return re.sub(r"[\\%_]", lambda m: "\\" + m.group(0), prefix) + "%"


def run_list(db, sql, prefix, limit):
    pattern = like_pattern(prefix)
    cursor = db.execute(sql, (pattern, pattern, pattern, limit))
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def insert_row(db, table, values):
    info = db.execute(f"PRAGMA table_info({table})").fetchall()
    columns = [row[1] for row in info]
    row = {}
    for _, name, declared, _, _, pk in info:
        if name in values:
            row[name] = values[name]
        elif pk and "INT" in (declared or "").upper():
            row[name] = None
        elif "INT" in (declared or "").upper():
            row[name] = 0
        elif any(kind in (declared or "").upper() for kind in ("REAL", "FLOA", "DOUB")):
            row[name] = 0.0
        else:
            row[name] = ""
    db.execute(
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        [row[column] for column in columns],
    )


def seed(db):
    # 120 recent notes fill the newest-100 window.
    for i in range(RECENT_COUNT):
        path = f"Notes/分野{i % 10}/最近{i}.md"
        insert_row(db, "notes", {
            "id": path, "path": path, "title": f"最近{i}",
            "content": "本文", "content_hash": f"h{i}",
            "imported_at": "2026-11-20T00:00:00Z",
            "updated_at": f"2026-11-20T00:{i % 60:02d}:00Z",
            "ai_allowed": 1, "deleted_at": None,
        })
    # The improvement memos: real notes, but untouched for weeks, so the
    # updated_at window never reaches them without a prefix.
    memo_paths = []
    for i in range(MEMO_COUNT):
        path = f"{MEMO_PREFIX}改善メモ{i}.md"
        insert_row(db, "notes", {
            "id": path, "path": path, "title": f"改善メモ{i}",
            "content": "改善の記録", "content_hash": f"memo{i}",
            "imported_at": "2026-10-01T00:00:00Z",
            "updated_at": f"2026-10-0{i + 1}T00:00:00Z",
            "ai_allowed": 1, "deleted_at": None,
        })
        memo_paths.append(path)
    # A deleted memo must stay invisible even with the prefix.
    insert_row(db, "notes", {
        "id": f"{MEMO_PREFIX}削除済み.md", "path": f"{MEMO_PREFIX}削除済み.md",
        "title": "削除済み", "content": "x", "content_hash": "del",
        "imported_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-05T00:00:00Z",
        "ai_allowed": 1, "deleted_at": "2026-10-06T00:00:00Z",
    })
    # LIKE wildcard look-alikes: `_` and `%` in a folder name are literal.
    for folder in ("進捗_2026", "進捗X2026", "100%活用", "1000活用"):
        path = f"Notes/{folder}/記録.md"
        insert_row(db, "notes", {
            "id": path, "path": path, "title": folder,
            "content": "x", "content_hash": f"h-{folder}",
            "imported_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z",
            "ai_allowed": 1, "deleted_at": None,
        })
    # Telegram notes have no path; one is the newest row overall.
    insert_row(db, "telegram_notes", {
        "id": "tg-new", "title": "電文 新", "content": "x", "content_hash": "tg1",
        "updated_at": "2026-11-21T00:00:00Z", "ai_allowed": 1,
        "chat_id": "fixture", "message_id": 1, "deleted_at": None,
    })
    insert_row(db, "telegram_notes", {
        "id": "tg-old", "title": "電文 古", "content": "x", "content_hash": "tg2",
        "updated_at": "2026-10-01T00:00:00Z", "ai_allowed": 1,
        "chat_id": "fixture", "message_id": 2, "deleted_at": None,
    })
    db.commit()
    return memo_paths


def main():
    source = SOURCE.read_text(encoding="utf-8")
    anchor = source.find("async function listNotes")
    if 'searchParams.get("prefix")' not in source[anchor:anchor + 2000]:
        fail("listNotes does not read the prefix query parameter")
    if "MAX_LIST_PREFIX_LENGTH" not in source:
        fail("prefix length cap constant is missing")

    sql = extract_list_sql()
    if "path LIKE ? ESCAPE '\\'" not in sql:
        fail("notes branch does not filter by an escaped LIKE prefix")
    if "FROM telegram_notes WHERE deleted_at IS NULL AND ? IS NULL" not in sql:
        fail("telegram branch is not excluded when a prefix is set")

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    memo_paths = seed(db)

    # Without a prefix the behavior is unchanged: newest 100 across both
    # tables, telegram included, and the old memos stay outside the window.
    rows = run_list(db, sql, "", 100)
    if len(rows) != 100:
        fail(f"no-prefix list should return the 100-row window, got {len(rows)}")
    paths = [row["path"] for row in rows]
    if any(path in paths for path in memo_paths):
        fail("fixture broken: improvement memos should be outside the no-prefix window")
    if not any(row["source"] == "telegram" for row in rows):
        fail("no-prefix list lost the telegram notes")

    # With the folder prefix, exactly the live memos come back, newest
    # first, and no telegram rows leak in.
    rows = run_list(db, sql, MEMO_PREFIX, 100)
    got = [row["path"] for row in rows]
    if got != list(reversed(memo_paths)):
        fail(f"prefix list should return the memos newest-first, got {got}")
    if any(row["source"] == "telegram" for row in rows):
        fail("telegram notes leaked into a prefixed list")

    # Wildcards in the prefix are literal characters, not patterns.
    rows = run_list(db, sql, "Notes/進捗_2026", 100)
    if [row["path"] for row in rows] != ["Notes/進捗_2026/記録.md"]:
        fail(f"underscore prefix matched more than the literal folder: {[r['path'] for r in rows]}")
    rows = run_list(db, sql, "Notes/100%", 100)
    if [row["path"] for row in rows] != ["Notes/100%活用/記録.md"]:
        fail(f"percent prefix matched more than the literal folder: {[r['path'] for r in rows]}")

    # A prefix that matches nothing returns an empty list, not an error.
    rows = run_list(db, sql, "Notes/存在しない/", 100)
    if rows:
        fail("non-matching prefix should return no rows")

    print(
        "PASS: list prefix filter returns folder notes outside the "
        f"updated-at window ({MEMO_COUNT} memos), keeps no-prefix behavior, "
        "excludes telegram notes and deleted notes, and treats % and _ literally."
    )


if __name__ == "__main__":
    main()
