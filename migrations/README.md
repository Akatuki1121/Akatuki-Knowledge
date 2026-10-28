# D1 migrations

The recovered SQL files `0001` through `0007` are present in this directory and are listed in the same order as the live `d1_migrations` ledger captured on 2026-10-19. They apply in order to an empty SQLite database.

**Important provenance limit:** the recovered files have not been independently compared byte-for-byte with the exact SQL text originally applied to production. Passing the clean-database test proves that this recovered sequence executes; it does not prove historical identity.

## Applied migrations 0008-0012

The live ledger records `0008` through `0012`. On 2026-10-22 the live schema was compared with `0001`-`0012` applied in order to an empty SQLite database; tables, columns, foreign keys and indexes were identical.

- `0008_folders_schema_reconstructed.sql` is a reconstruction, not the original historical change. Production already had the `folders` table and `notes.folder_id` before the ledger recorded it. Do not run it against production again: `ALTER TABLE notes ADD COLUMN folder_id` would fail on the existing column.
- `0009`, `0011` and `0012` were applied on 2026-10-20 and 2026-10-21; `0010` was applied after `0011` and `0012`. Wrangler decides by name, so the order in the ledger does not matter.

## Applied migration 0015 (verification gate)

The DDL in `0015_yaos_file_identity_map.sql` was applied to production D1 on 2026-10-28 after owner authorization; the two tables and two indexes were verified in the D1 Console. The production D1 `d1_migrations` ledger was verified after the owner-authorized INSERT: exactly one row exists for `0015_yaos_file_identity_map.sql` (`id=15`, `applied_at=2026-10-28 17:23:06 UTC`) and the ledger has 15 rows total. The existing rows `id=1` through `14` and their `name`/`applied_at` values were unchanged. `applied_at` is the approved ledger-recording time, not a reconstructed DDL execution time. The migration record and repository file are aligned; `applied_at` intentionally records the approved ledger insertion time.

## `pending/`

Put a migration that has not been applied to production in `migrations/pending/`. While that directory holds any `.sql` file, the GitHub Actions production deploy is skipped. Move the file up to `migrations/` after it has been applied and recorded in `d1_migrations`.
## Schema snapshots

- `../schema-snapshots/live-d1-schema-2026-10-19.sql` is a read-only capture of table/index definitions, not an ordered migration.
- `../schema-snapshots/legacy-0001-initial-evolved-schema.sql` preserves the earlier repository file that was named `0001_initial.sql`. It is an evolved schema snapshot, not a verified clean-database bootstrap migration.

Neither snapshot should be run as a production migration.
