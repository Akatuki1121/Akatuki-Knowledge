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

The live version API does not expose the original migration arrays. The local file is the recovered source for the operation declarations; it has not been independently proven against each historical deployment artifact. Preserve the declarations in order and do not rewrite, collapse, or reorder them. Cloudflare's legacy migration documentation states that `deleted_classes` deletes all Durable Objects for that class, including stored data. If this recovered history reflects the operations applied, `v2` and `v4` were destructive transitions; do not assume data from the earlier namespaces survived. The live Worker currently uses the `v5` namespace. The successful local dry-run does not verify remote migration reconciliation or prove a production deployment safe. In particular, do not create a new namespace manually or deploy this recovery config to production until that reconciliation behavior is independently reviewed.

## D1 migration history

Live `d1_migrations` records:

- 1. `0001_initial.sql` — applied_at `1792230000`
- 2. `0002_ai_privacy.sql` — applied_at `1792230001`
- 3. `0003_telegram_workflow.sql` — applied_at `1792325000`
- 4. `0004_sensitive_content_policy.sql` — applied_at `1792325001`
- 5. `0005_conversation_memory.sql` — applied_at `2026-10-18 08:41:04`
- 6. `0006_bot_alerts.sql` — applied_at `2026-10-18 08:53:48`
- 7. `0007_failure_stage.sql` — applied_at `2026-10-18 09:33:30`

Legacy backup table records only `0001` through `0004` and their timestamps; it does not preserve the SQL text.

The earlier repository file named `migrations/0001_initial.sql` was an evolved schema snapshot, including the `d1_migrations` table itself. It has been preserved as `schema-snapshots/legacy-0001-initial-evolved-schema.sql`. A separate set of SQL files `migrations/0001_initial.sql` through `0007_failure_stage.sql` has since been restored from a local backup and is now in the recovery branch. These files apply in order to an empty SQLite database, but they have not been independently proven byte-for-byte identical to the SQL originally applied in production.

Migrations `0001`–`0007` do not create the live `folders` table or add `notes.folder_id`, even though both exist in the captured live schema. The origin of this drift is unknown. A newly reconstructed forward migration candidate, `migrations/pending/0008_folders_schema_reconstructed.sql`, reproduces these objects for a clean database; it is not claimed to be the original historical change. CI validates the reconstructed chain plus this candidate against the captured tables, column definitions, foreign keys, and index definitions. Keep it pending: production already has these objects, while its recorded ledger does not explain them, so running the candidate there would fail on the existing `folder_id` column. The YAOS outbox candidate is numbered `0009_yaos_sync_jobs.sql` to preserve sequence after the folder-schema candidate.

The live schema at `schema-snapshots/live-d1-schema-2026-10-19.sql` is a reference snapshot only and must not be run as a migration.

## Remaining recovery work

1. Reconcile the out-of-ledger `folders` / `notes.folder_id` schema with the production migration ledger using a reviewed, non-destructive procedure before moving the pending migration into the executable chain.
2. Keep the recovered `0001`–`0007` chain as a candidate for clean-database recovery, while treating its exact historical provenance as unverified.
3. Complete a staging deployment and YAOS Durable Object/WebSocket end-to-end tests before considering production rollout.

No Cloudflare settings, secrets, Worker code, or D1 data were changed during this recovery step. The new Wrangler config is only in the GitHub recovery branch and has not been deployed.

## Follow-up validation (2026-10-19)

- Added `scripts/test_worker_sql_compatibility.py`, which compiles extracted SQL statements against the captured schema with SQLite `EXPLAIN`. The latest successful run at the time of this note is [GitHub Actions run 39215278853](https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39215278853): 110 SQL statement variants compiled; the clean-schema test and Worker syntax check passed.
- The SQL test found two queries that selected `path` from `telegram_notes`, where that column does not exist. The recovery branch now selects `NULL AS path` for Telegram notes. This is a targeted bug fix relative to the deployed source, kept off `main` pending review.
- The live-vs-repository comparison confirms that `main/src/index.js` matches the deployed module content; the backup branch copy is wrapped in a multipart envelope and must be extracted before use. The same comparison found a config/code mismatch: the live cron is hourly (`0 * * * *`), while the code only starts the scheduled pull for `*/5 * * * *`. This indicates a likely scheduled-sync gap; it has not been changed in production. Details: [live-vs-repository comparison](CLOUDFLARE_LIVE_VS_REPOSITORY_DIFF.md).
- Read-only Cloudflare Worker version metadata confirms migration tags `v1`–`v5` and shows namespace IDs changing between the recorded v1, v3, and v5 versions. It does not include the original Wrangler migration operation arrays. See [Durable Object version evidence](DURABLE_OBJECT_VERSION_EVIDENCE.md).
- These checks are static/local-schema checks only. They are not a staging deployment or a Cloudflare D1 integration test. No production Worker, D1, or Durable Object instances were changed by this follow-up.


## YAOS source and isolated test harness found (2026-10-19)

A public YAOS source candidate has now been located: [kavinsood/yaos](https://github.com/kavinsood/yaos). Its current `server/src/server.ts` contains the `VaultSyncServer extends YServer<Env>` implementation, matching the class name seen in the recovered deployment context. This is a strong source lead, **not proof** that the current deployed `yaos` Worker was built from the current `main` commit; deployed artifact provenance still needs verification.

The repository includes a real local Worker integration suite:
- `npm run test:integration:worker` runs `tests/live/run-live.ts`.
- The harness starts `wrangler dev` bound to `127.0.0.1:8787`, uses a randomly generated test vault ID and auth token, and passes a temporary `--persist-to` directory.
- The suite exercises the local Worker, Durable Object/WebSocket sync, snapshots, admission protocol, and reconnect behavior. It does not require writing to the production YAOS vault.
- The repository's `test:ci` script runs regression tests plus this local Worker integration suite.

The recovery branch now includes `scripts/test_yaos_worker_integration.mjs`, which establishes the local service-binding path between the recovery-branch Knowledge Worker and this isolated YAOS Worker. GitHub Actions run [39339277481](https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39339277481) passed the end-to-end scenarios: create, update, rename, delete, restore, retry after a temporary auth failure, and refusal to overwrite an independent Vault edit. The test uses disposable local D1/DO state, a random test vault ID and token, and does not point at the production service binding.

This closes the local integration-test gap, but does not substitute for a separate Cloudflare staging deployment or prove remote Durable Object migration reconciliation. Keep production rollout blocked until staging and migration review are complete.

No YAOS repository, Worker, or Cloudflare resource was changed as part of this source discovery.
