#!/usr/bin/env python3
"""Regression test for the note search suppression check (findRelevantNotes).

Production measurement (2026-11-23, d1QueriesAdaptiveGroups): one search
execution read ~150,000 rows while returning at most a dozen, because the
suppression check was a single NOT EXISTS whose three OR-ed conditions
forced SQLite to scan every agent_memory_suppressions row for every note
row (1,132 notes x 198 suppressions). In the 2026-11-22T23:00Z hour the
search query accounted for 5.88M of the 5.33M-row daily free quota breach
pattern (38 executions, 4,999,914 + 439,644 + 438,924 rows).

This test extracts the actual SQL template from src/index.js, builds it
for a two-term query exactly as the Worker does, and asserts against a
production-shaped fixture set (counts observed in production on
2026-11-23: 1,089 notes, 43 telegram notes, 52 memory metadata rows,
198 suppression rows):

- the query plan never SCANs agent_memory_suppressions (every access is
  an index SEARCH), and
- the suppression semantics are unchanged: notes are excluded when a
  suppression matches by content hash, by a memory key hash of the
  note's own metadata, or by a value hash of the note's own metadata
  (including metadata whose status is 'forgotten', which the check has
  never filtered on), while unrelated notes still rank by relevance.
"""
import hashlib
import random
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "index.js"
SCHEMA = ROOT / "schema-snapshots" / "live-d1-schema-2026-10-19.sql"
MIGRATIONS = [
    ROOT / "migrations" / "0009_yaos_sync_jobs.sql",
    ROOT / "migrations" / "0010_bot_organization_candidates.sql",
    ROOT / "migrations" / "0011_agent_tasks.sql",
    ROOT / "migrations" / "0019_agent_task_attention_and_reassessment.sql",
    ROOT / "migrations" / "0012_bot_ai_permission_previews.sql",
    ROOT / "migrations" / "0013_agent_memory_metadata.sql",
    ROOT / "migrations" / "0015_yaos_file_identity_map.sql",
]

TERMS = ["回路", "設計"]
NOTE_COUNT = 1089
TELEGRAM_COUNT = 43
METADATA_COUNT = 52
SUPPRESSION_COUNT = 198


def fail(message):
    print(f"FAIL: {message}")
    raise SystemExit(1)


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_search_sql():
    source = SOURCE.read_text(encoding="utf-8")
    anchor = source.find("async function findRelevantNotes")
    if anchor < 0:
        fail("findRelevantNotes not found in src/index.js")
    match = re.search(r"const sql = `([\s\S]*?)`;", source[anchor:])
    if not match:
        fail("search SQL template not found in findRelevantNotes")
    template = match.group(1)
    # Build ${conditions} and ${score} exactly as findRelevantNotes does.
    conditions = " OR ".join(
        "(title LIKE ? OR COALESCE(path, '') LIKE ? OR content LIKE ? OR summary LIKE ?)"
        for _ in TERMS
    )
    score = " + ".join(
        "(CASE WHEN title LIKE ? OR COALESCE(path, '') LIKE ? THEN 5 WHEN summary LIKE ? THEN 3 WHEN content LIKE ? THEN 1 ELSE 0 END)"
        for _ in TERMS
    )
    sql = template.replace("${score}", f"({score})").replace("${conditions}", conditions)
    if "${" in sql:
        fail("unexpanded placeholder left in extracted search SQL")
    bindings = []
    for term in TERMS:  # score bindings first (the score is in the SELECT clause)
        bindings.extend([f"%{term}%"] * 4)
    for term in TERMS:  # then the WHERE condition bindings, in the same order
        bindings.extend([f"%{term}%"] * 4)
    bindings.append(50)
    return sql, bindings


def build_db():
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    for migration in MIGRATIONS:
        db.executescript(migration.read_text(encoding="utf-8"))
    return db


def insert_row(db, table, values):
    info = db.execute(f"PRAGMA table_info({table})").fetchall()
    columns = [row[1] for row in info]
    row = {}
    for _, name, declared, _, _, pk in info:
        if name in values:
            row[name] = values[name]
        elif pk and "INT" in (declared or "").upper():
            row[name] = None  # let SQLite assign the rowid primary key
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
    random.seed(20261123)
    words = "回路 設計 電子工作 基板 電源 知識 同期 整理 会議 資料 開発 実験 測定".split()

    def content(tag):
        lines = []
        for _ in range(random.randint(8, 30)):
            lines.append(" ".join(random.choices(words, k=6)) + "。")
        return f"# {tag}\n" + "\n".join(lines)

    note_ids = []
    for i in range(NOTE_COUNT):
        body = content(f"ノート{i}")
        path = f"Notes/分野{i % 20}/ノート{i}.md"
        insert_row(db, "notes", {
            "id": path, "path": path, "title": f"ノート{i}",
            "content": body, "content_hash": sha256(body),
            "imported_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-20T00:00:00Z",
            "sync_uuid": f"{sha256('u' + str(i))[:8]}-0000-5000-8000-000000000000",
            "ai_allowed": 1, "deleted_at": None,
        })
        note_ids.append(path)
    for i in range(TELEGRAM_COUNT):
        body = content(f"電文{i}")
        insert_row(db, "telegram_notes", {
            "id": f"tg{i}", "title": f"電文{i}", "content": body,
            "content_hash": sha256(body), "updated_at": "2026-11-20T00:00:00Z",
            "ai_allowed": 1, "chat_id": "fixture", "message_id": i + 1, "deleted_at": None,
        })
    for i in range(METADATA_COUNT):
        insert_row(db, "agent_memory_metadata", {
            "source": "obsidian", "note_id": note_ids[i % len(note_ids)],
            "memory_kind": "fact", "trust_level": "user_stated", "status": "active",
            "confidence": 0.9, "source_ref": "fixture",
            "memory_key_hash": sha256(f"filler-key-{i}"),
            "value_hash": sha256(f"filler-value-{i}"),
            "content_hash": sha256(f"filler-content-{i}"),
            "recorded_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
        })
    for i in range(SUPPRESSION_COUNT):
        insert_row(db, "agent_memory_suppressions", {
            "source": "obsidian", "note_id": note_ids[i % len(note_ids)],
            "content_hash": sha256(f"filler-suppressed-content-{i}"),
            "memory_key_hash": sha256(f"filler-suppressed-key-{i}") if i % 2 else None,
            "value_hash": sha256(f"filler-suppressed-value-{i}") if i % 3 else None,
            "created_at": "2026-11-01T00:00:00Z",
        })

    targeted = {}

    def add_note(name, title, body):
        path = f"Notes/対象/{name}.md"
        insert_row(db, "notes", {
            "id": path, "path": path, "title": title,
            "content": body, "content_hash": sha256(body),
            "imported_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-21T00:00:00Z",
            "sync_uuid": f"{sha256('u-' + name)[:8]}-0000-5000-8000-000000000000",
            "ai_allowed": 1, "deleted_at": None,
        })
        targeted[name] = path
        return path

    # Excluded by content hash: a suppression recorded for another note
    # carries this note's exact content hash.
    body = "回路 の 設計 についての詳細な記録。回路 設計 回路 設計"
    add_note("suppressed-content", "回路 設計 content", body)
    insert_row(db, "agent_memory_suppressions", {
        "source": "obsidian", "note_id": "Notes/分野0/ノート0.md",
        "content_hash": sha256(body), "memory_key_hash": None, "value_hash": None,
        "created_at": "2026-11-02T00:00:00Z",
    })

    # Excluded by memory key hash: the note's own metadata key hash appears
    # in a suppression recorded under a different source and note.
    body = "回路 設計 key の記録。回路 設計"
    path = add_note("suppressed-key", "回路 設計 key", body)
    insert_row(db, "agent_memory_metadata", {
        "source": "obsidian", "note_id": path, "memory_kind": "fact",
        "trust_level": "user_stated", "status": "active", "confidence": 0.9,
        "source_ref": "fixture", "memory_key_hash": sha256("target-key"),
        "value_hash": sha256("target-key-value"), "content_hash": sha256(body),
        "recorded_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
    })
    insert_row(db, "agent_memory_suppressions", {
        "source": "telegram", "note_id": "tg0",
        "content_hash": sha256("unrelated-content"), "memory_key_hash": sha256("target-key"),
        "value_hash": None, "created_at": "2026-11-02T00:00:00Z",
    })

    # Excluded by value hash even though the metadata row is 'forgotten':
    # the suppression check has never filtered metadata by status.
    body = "回路 設計 value の記録。回路 設計"
    path = add_note("suppressed-value", "回路 設計 value", body)
    insert_row(db, "agent_memory_metadata", {
        "source": "obsidian", "note_id": path, "memory_kind": "fact",
        "trust_level": "user_stated", "status": "forgotten", "confidence": 0.9,
        "source_ref": "fixture", "memory_key_hash": sha256("target-value-key"),
        "value_hash": sha256("target-value"), "content_hash": sha256(body),
        "recorded_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
    })
    insert_row(db, "agent_memory_suppressions", {
        "source": "obsidian", "note_id": "Notes/分野1/ノート1.md",
        "content_hash": sha256("unrelated-content-2"), "memory_key_hash": None,
        "value_hash": sha256("target-value"), "created_at": "2026-11-02T00:00:00Z",
    })

    # Control: has metadata and unrelated suppressions exist; must appear.
    body = "回路 設計 control の記録。回路 設計"
    path = add_note("control", "回路 設計 control", body)
    insert_row(db, "agent_memory_metadata", {
        "source": "obsidian", "note_id": path, "memory_kind": "fact",
        "trust_level": "user_stated", "status": "active", "confidence": 0.9,
        "source_ref": "fixture", "memory_key_hash": sha256("control-key"),
        "value_hash": sha256("control-value"), "content_hash": sha256(body),
        "recorded_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
    })

    # Ranking control: a title match (score 5 per term) must outrank a
    # content-only match (score 1 per term).
    add_note("rank-title", "回路 設計 タイトル一致", "本文は無関係な話題だけ。")
    add_note("rank-content", "無関係な題", "回路 と 設計 が本文にだけ出る。回路 設計")
    db.commit()
    return targeted


def main():
    sql, bindings = extract_search_sql()
    db = build_db()
    targeted = seed(db)

    plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, bindings)]
    alias_match = re.search(r"agent_memory_suppressions\s+(\w+)", sql)
    alias = alias_match.group(1) if alias_match else "s"
    suppression_access = [
        line for line in plan
        if "suppression" in line or re.match(rf"(?:SCAN|SEARCH) {re.escape(alias)}\b", line)
    ]
    if not suppression_access:
        fail("query plan does not touch agent_memory_suppressions at all")
    scans = [line for line in suppression_access if line.lstrip().startswith("SCAN")]
    if scans:
        fail("search plan scans agent_memory_suppressions (per-note rescan is back): " + "; ".join(scans))

    cursor = db.execute(sql, bindings)
    columns = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()
    id_index = columns.index("id")
    relevance_index = columns.index("relevance")
    result_ids = [row[id_index] for row in rows]

    for name in ("suppressed-content", "suppressed-key", "suppressed-value"):
        if targeted[name] in result_ids:
            fail(f"suppressed note returned by search: {name}")
    if targeted["control"] not in result_ids:
        fail("control note missing from search results")
    if targeted["rank-title"] not in result_ids or targeted["rank-content"] not in result_ids:
        fail("ranking fixture notes missing from search results")
    if result_ids.index(targeted["rank-title"]) > result_ids.index(targeted["rank-content"]):
        fail("title match no longer outranks content-only match")

    print(
        "PASS: search suppression check uses index searches only "
        f"({len(suppression_access)} suppressions accesses), semantics preserved "
        f"on production-shaped fixtures ({NOTE_COUNT} notes, {SUPPRESSION_COUNT} suppressions)."
    )


if __name__ == "__main__":
    main()
