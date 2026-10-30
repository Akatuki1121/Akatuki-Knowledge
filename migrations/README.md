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


## Pending migrations 0016-0018 (verified 2026-10-30)

The production D1 migration ledger was read-only checked on 2026-10-30. Its latest row is still `0015_yaos_file_identity_map.sql` (id 15). The live `agent_task_daily_budget` table still has `tasks_reserved BETWEEN 0 AND 60` and `workflow_steps_reserved BETWEEN 0 AND 2000`; `workers_ai_daily_usage` does not yet exist. Therefore the PR #174 migrations have **not** been applied to production D1, despite PR #174 being merged into GitHub.

Keep the following files in `pending/` until an owner-approved production D1 rollout has applied them and recorded their names in `d1_migrations`:

- `pending/0016_workers_ai_daily_usage.sql`: creates the daily Workers AI Neurons ledger.
- `pending/0017_cloudflare_free_workflow_budget.sql`: removes the old 60-task constraint and changes the reserved Workflow-step ceiling to 2,700.
- `pending/0018_workers_ai_failed_calls.sql`: adds the failed-call counter to the 0016 ledger.

Apply in numeric order. The deploy workflow intentionally skips production deployment while any `migrations/pending/*.sql` file exists. After the owner-approved D1 rollout is complete and the ledger is verified, move the files into the root `migrations/` directory in a separate reviewed change.


## Production rollout status: 0016-0018

2026-10-30の読み取り確認では、production D1 ledgerの最新は0015（id 15）。同日のmain commit `cd4a9f5` のWorker deploy workflowは成功しているが、D1 schemaはまだ旧状態（60 tasks / 2,000 Workflow steps）で、`workers_ai_daily_usage` も存在しない。つまりWorkerコードとD1 schemaが不一致になっている。

PR #175では0016・0017・0018を `migrations/pending/` に配置し、次回以降のproduction deployを停止する。オーナー承認のあるD1 rolloutで0016→0017→0018を適用し、`d1_migrations` ledgerとschemaを確認するまで、pendingからroot `migrations/` へ移動しない。Worker再デプロイもD1適用・検証後に別途承認を得て実施する。
