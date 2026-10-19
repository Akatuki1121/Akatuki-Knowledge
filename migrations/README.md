# D1 migrations

The recovered SQL files `0001` through `0007` are present in this directory and are listed in the same order as the live `d1_migrations` ledger captured on 2026-10-19. They apply in order to an empty SQLite database.

**Important provenance limit:** the recovered files have not been independently compared byte-for-byte with the exact SQL text originally applied to production. Passing the clean-database test proves that this recovered sequence executes and produces the expected schema shape; it does not prove historical identity.

## Known live-schema drift

The live schema capture contains a `folders` table and a `notes.folder_id` column that are absent from migrations `0001`–`0007`. The original change that introduced these objects, and whether it was applied manually or through another unrecorded path, has not been found. The CI check `scripts/test_recovered_migration_chain.py` asserts that this is the only table/column difference between the recovered chain and the captured live schema.

Do not add a guessed historical migration under `0001`–`0007`, and do not run the recovered chain against the existing production database. Production already has the folder schema even though the recorded ledger does not describe its origin. A normal `ALTER TABLE notes ADD COLUMN folder_id` would fail there.

## YAOS event-sync migration

`pending/0008_yaos_sync_jobs.sql` adds `notes.sync_uuid` and the `yaos_sync_jobs` outbox table. It remains under `pending/` rather than the executable migrations directory because production schema/ledger reconciliation and the deployment sequence are not yet approved or validated. Do not apply it to production yet.

## Schema snapshots

- `../schema-snapshots/live-d1-schema-2026-10-19.sql` is a read-only capture of table/index definitions, not an ordered migration.
- `../schema-snapshots/legacy-0001-initial-evolved-schema.sql` preserves the earlier repository file that was named `0001_initial.sql`. It is an evolved schema snapshot, not a verified clean-database bootstrap migration.

Neither snapshot should be run as a production migration.
