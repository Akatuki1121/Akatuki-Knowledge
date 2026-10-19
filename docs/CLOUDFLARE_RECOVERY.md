# Cloudflare source and D1 recovery notes

Captured 2026-10-19 from the live Cloudflare Worker `akatuki-knowledge` and its bound D1 database. This document records observed configuration; it does not contain secret values.

## Worker

- Worker name: `akatuki-knowledge`
- Runtime compatibility date: `2026-10-17`
- Usage model: `standard`
- Scheduled trigger: `0 * * * *` (hourly)
- Current deployed Durable Object migration tag: `v5`
- Latest observed deployment: 2026-10-18 17:58:28 UTC, version 49

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

Version metadata shows migration tags changing from `v1` to `v2`, `v3`, `v4`, and `v5`. The class `YjsClientDO` and binding `YJS_CLIENT` appear in the deployment metadata, but Cloudflare's version metadata does not provide the original Wrangler migration declarations. Do not guess these declarations or deploy a reconstructed configuration until the migration history has been recovered.

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

The previous `migrations/0001_initial.sql` was an evolved schema snapshot, including the `d1_migrations` table itself, not a verified clean-database bootstrap migration. It has been preserved as `schema-snapshots/legacy-0001-initial-evolved-schema.sql` and removed from the executable migrations directory. The live schema is preserved separately at `schema-snapshots/live-d1-schema-2026-10-19.sql`. Both files are reference snapshots only and must not be run as migrations.

## Remaining recovery work

1. Recover original D1 migration SQL `0001`–`0007` from source history/backups; do not reverse-engineer and label guessed SQL as original.
2. Recover the exact Wrangler Durable Object migration declarations for tags `v1`–`v5`.
3. `wrangler.jsonc` is now a recovered configuration draft and is checked in CI. It is not deploy-ready until the original Durable Object migration declarations are recovered; no deploy workflow should run before that.
4. Validate clean-database migrations and a staging deployment before any production deploy.

No Cloudflare settings, secrets, Worker code, or D1 data were changed during this capture.
