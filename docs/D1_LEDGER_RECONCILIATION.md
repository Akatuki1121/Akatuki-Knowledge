# Production D1 ledger reconciliation runbook

Status: **procedure only; not executed against production**. This runbook is for the recovery branch and the live D1 capture dated 2026-10-19.

> **Update 2026-10-22:** the live ledger already records `0008`–`0012` (`0008`/`0009` on 2026-10-20, `0011`/`0012` then `0010` on 2026-10-21). A read-only comparison of the live schema with `0001`–`0012` applied to an empty SQLite found no differences in tables, columns, foreign keys or indexes. The files were moved from `migrations/pending/` to `migrations/`. The procedure below is kept as the historical record of how the gap was handled.

## Known state

- The live `d1_migrations` ledger records `0001` through `0007`.
- The live schema also contains `folders`, `notes.folder_id`, and the indexes `idx_folders_kind`, `idx_folders_parent`, and `idx_notes_folder`.
- Recovered `0001`–`0007` files do not create those folder objects. Their exact identity with the SQL historically applied in production is unverified.
- `migrations/pending/0008_folders_schema_reconstructed.sql` is a reconstructed candidate, not recovered historical SQL. `migrations/pending/0009_yaos_sync_jobs.sql` is the event-outbox migration.
- The pending folder migration must **not** be run against the live database: its `ALTER TABLE notes ADD COLUMN folder_id` would collide with the existing column.

## Phase A — read-only verification

Run these queries against the intended D1 database using a read-only path where available. Do not use a query console/session that may execute writes.

```sql
SELECT id, name, applied_at
FROM d1_migrations
ORDER BY id;

SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE (type = 'table' AND name IN ('folders', 'notes'))
   OR (type = 'index' AND name IN (
     'idx_folders_kind', 'idx_folders_parent', 'idx_notes_folder'
   ))
ORDER BY type, name;

PRAGMA table_info('folders');
PRAGMA table_info('notes');
PRAGMA foreign_key_list('folders');
PRAGMA foreign_key_list('notes');
PRAGMA index_list('folders');
PRAGMA index_list('notes');

SELECT
  COUNT(*) AS total_notes,
  SUM(CASE WHEN folder_id IS NULL THEN 1 ELSE 0 END) AS null_folder_id,
  SUM(CASE WHEN folder_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned_folder_id
FROM notes;

SELECT n.id, n.folder_id
FROM notes AS n
LEFT JOIN folders AS f ON f.id = n.folder_id
WHERE n.folder_id IS NOT NULL AND f.id IS NULL
LIMIT 50;
```

Save the query results with the recovery evidence. Compare the full table definition, column types/nullability/defaults, foreign keys, and index definitions—not just the presence of names—with the candidate migration and `schema-snapshots/live-d1-schema-2026-10-19.sql`. Investigate any difference before proceeding. A row-count check is not a substitute for schema comparison.

## Phase B — review gate before any ledger write

Do not reconcile the ledger until all of the following are true:

1. A fresh, restorable backup/export of the production D1 database has been obtained and its availability confirmed.
2. The read-only results above prove the live folder schema is structurally equivalent to the intended effect of the reconstructed `0008` migration, including indexes and foreign-key behavior.
3. The exact `0001`–`0007` production history has been reviewed as an unresolved provenance gap; do not represent the recovered files as byte-identical originals.
4. A reviewer approves recording the already-present folder schema in the migration ledger without executing its DDL.

If any check fails, stop. Do not attempt to “fix” the database by replaying `0001`–`0008`, dropping objects, or editing application data.

## Phase C — proposed reconciliation (not authorized or executed)

Once Phase B is approved, the intended approach is to make the folder migration an executable, ordered migration and record its migration name in `d1_migrations` **without executing the folder DDL a second time**. This is a ledger reconciliation, not a schema migration. The exact write procedure must be reviewed against the installed Wrangler/D1 migration behavior before execution.

After the ledger is reconciled, re-read `d1_migrations` and all folder schema metadata and compare them with the saved Phase A evidence. Do not proceed if the ledger or schema differs from the approved expected state.

The YAOS outbox migration (`0009_yaos_sync_jobs.sql`) is a separate later operation. Do not apply it until the YAOS event-sync path has passed isolated end-to-end tests and the production rollout has a reviewed backup, rollback, and monitoring plan.

## Safety boundary

This document does not authorize production changes. No D1 writes, migration applications, Worker deployments, secret changes, or YAOS writes are performed by this procedure itself. The captured schema snapshot is documentary evidence, not an executable migration.
