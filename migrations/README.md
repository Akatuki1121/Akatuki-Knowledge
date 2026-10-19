# D1 migrations

The recovered SQL files `0001` through `0007` are present in this directory and are listed in the same order as the live `d1_migrations` ledger captured on 2026-10-19. They apply in order to an empty SQLite database.

**Important provenance limit:** the recovered files have not been independently compared byte-for-byte with the exact SQL text originally applied to production. Passing the clean-database test proves that this recovered sequence executes; it does not prove historical identity.

## Pending folder-schema reconstruction

The live schema contains a `folders` table and a `notes.folder_id` column that are absent from migrations `0001`–`0007`. The origin of this schema change is unknown. A new forward migration candidate is preserved at `pending/0008_folders_schema_reconstructed.sql`; it is explicitly not claimed to be the original historical change.

The candidate applies cleanly after `0001`–`0007` on an empty SQLite database and makes the resulting table/column shape match the captured live schema. CI verifies this structural match. It does not establish when the production schema was added.

**Do not move this migration into the executable `migrations/` directory or run it against production yet.** Production already has `folders` and `notes.folder_id`, but the ledger does not record the migration. Running the candidate normally against production would fail on the existing `folder_id` column. A reviewed procedure must first verify the live schema and reconcile the ledger without rerunning the DDL.

## Pending YAOS event-sync migration

`pending/0009_yaos_sync_jobs.sql` adds `notes.sync_uuid` and the `yaos_sync_jobs` outbox table. It remains pending until the folder-schema/ledger reconciliation and deployment sequence have been reviewed. Do not apply it to production yet.

## Schema snapshots

- `../schema-snapshots/live-d1-schema-2026-10-19.sql` is a read-only capture of table/index definitions, not an ordered migration.
- `../schema-snapshots/legacy-0001-initial-evolved-schema.sql` preserves the earlier repository file that was named `0001_initial.sql`. It is an evolved schema snapshot, not a verified clean-database bootstrap migration.

Neither snapshot should be run as a production migration.
