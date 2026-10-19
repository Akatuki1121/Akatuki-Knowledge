# Cloudflare source and D1 recovery notes

Captured 2026-10-19 from the live Cloudflare Worker `akatuki-knowledge` and its bound D1 database. This document records observed configuration; it does not contain secret values.

## Worker

- Worker name: `akatuki-knowledge`
- Runtime compatibility date: `2026-10-17`
- Usage model: `standard`
- Scheduled trigger: `0 * * * *` (hourly)
- Current deployed Durable Object migration tag: `v5`
- Latest observed deployment during the original capture: 2026-10-18 17:58:28 UTC, version 49; a later read observed version 51 on 2026-10-19.
- The recovered `wrangler.toml` points to `src/index.js`, the recovered repository entrypoint, rather than the older local `src/index.ts` or alternate `dist/wrapper.js` paths.

## Bindings

| Binding | Observed configuration |
| --- | --- |
| `DB` | D1 database `Akatuki-knowledge`, ID `e8c57dbe-0175-43d8-9c16-0501e0c1d5a6` |
| `YAOS` | Service binding to `yaos`, environment `production` |
| `YJS_CLIENT` | Durable Object namespace, class `YjsClientDO` |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `GEMINI_LIGHT_MODEL` | `gemini-3.1-flash-lite` |
| `ORGANIZE_PER_RUN` | `2` |

Secret binding names observed (values intentionally not exported): `API_TOKEN`, `GEMINI_API_KEY`, `TELEGRAM_ALLOWED_CHAT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `VAULT_ID`, `YAOS_TOKEN`.

## Durable Object migration history

The recovered local Wrangler configuration contains these declarations, and the live Worker version metadata independently confirms that the applied migration tag reached `v5`:

| Tag | Wrangler operation |
| --- | --- |
| `v1` | `new_sqlite_classes = ["YjsClientDO"]` |
| `v2` | `deleted_classes = ["YjsClientDO"]` |
| `v3` | `new_sqlite_classes = ["YjsClientDO"]` |
| `v4` | `deleted_classes = ["YjsClientDO"]` |
| `v5` | `new_sqlite_classes = ["YjsClientDO"]` |

The live version API does not expose the original migration arrays. The local file is the recovered source for the operation declarations; it has not been independently proven against each historical deployment artifact. Preserve the declarations in order and do not rewrite, collapse, or reorder them. In particular, the repeated delete/recreate operations are not a reason to create a new namespace manually.

## D1 migration history

Live `d1_migrations` records:

- 1. `0001_initial.sql` — applied_at `1792230000`
- 2. `0002_ai_privacy.sql` — applied_at `1792230001`
- 3. `0003_telegram_workflow.sql` — applied_at `1792325000`
- 4. `0004_telegram_workflow.sql` — applied_at `1792325001`
- 5. `0005_conversation_memory.sql` — applied_at `2026-10-18 08:41:04`
- 6. `0006_bot_alerts.sql` — applied_at `2026-10-18 08:53:48`
- 7. `0007_failure_stage.sql` — applied_at `2026-10-18 09:33:30`

Legacy backup table records only `0001` through `0004` and their timestamps; it does not preserve the SQL text.

The previous `migrations/0001_initial.sql` was an evolved schema snapshot, including the `d1_migrations` table itself, not a verified clean-database bootstrap migration. It has been preserved as `schema-snapshots/legacy-0001-initial-evolved-schema.sql` and removed from the executable migrations directory. The live schema is preserved separately at `schema-snapshots/live-d1-schema-2026-10-19.sql`. Both files are reference snapshots only and must not be run as migrations.

## Remaining recovery work

1. Compare the live Worker bundle with the repository source and keep any compatibility fixes isolated until reviewed. See [live-vs-repository comparison](CLOUDFLARE_LIVE_VS_REPOSITORY_DIFF.md).
2. Validate the reconstructed Wrangler config with the installed Wrangler version, without deploying it to production.
3. Recover original D1 migration SQL `0001`–`0007` from source history/backups if possible. This is for disaster recovery or a separate clean database; it is not a reason to recreate or modify the current production D1.
4. A staging deployment is a later pre-deployment validation step, not part of the read-only source comparison.

No Cloudflare settings, secrets, Worker code, or D1 data were changed during this recovery step. The new Wrangler config is only in the GitHub recovery branch and has not been deployed.

## Follow-up validation (2026-10-19)

- Added `scripts/test_worker_sql_compatibility.py`, which compiles extracted SQL statements against the captured schema with SQLite `EXPLAIN`. The latest successful run at the time of this note is [GitHub Actions run 39215278853](https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39215278853): 110 SQL statement variants compiled; the clean-schema test and Worker syntax check passed.
- The SQL test found two queries that selected `path` from `telegram_notes`, where that column does not exist. The recovery branch now selects `NULL AS path` for Telegram notes. This is a targeted bug fix relative to the deployed source, kept off `main` pending review.
- The live-vs-repository comparison confirms that `main/src/index.js` matches the deployed module content; the backup branch copy is wrapped in a multipart envelope and must be extracted before use. The same comparison found a config/code mismatch: the live cron is hourly (`0 * * * *`), while the code only starts the scheduled pull for `*/5 * * * *`. This indicates a likely scheduled-sync gap; it has not been changed in production. Details: [live-vs-repository comparison](CLOUDFLARE_LIVE_VS_REPOSITORY_DIFF.md).
- Read-only Cloudflare Worker version metadata confirms migration tags `v1`–`v5` and shows namespace IDs changing between the recorded v1, v3, and v5 versions. It does not include the original Wrangler migration operation arrays. See [Durable Object version evidence](DURABLE_OBJECT_VERSION_EVIDENCE.md).
- These checks are static/local-schema checks only. They are not a staging deployment or a Cloudflare D1 integration test. No production Worker, D1, or Durable Object instances were changed by this follow-up.
