# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Production status (2026-10-20)

- The recovered Worker source is `src/index.js`. YAOS event-sync PR #14 was merged as `46ab2b71dbe66f4247af274c3a0ed47d1aad4b68`. Cloudflare currently routes 100% of production traffic to Worker version 65 (`41c8cfc7-f94a-4669-833c-6e75cec70d13`), uploaded on 2026-10-20 at 08:00:52 UTC. The active configuration retains the production D1, YAOS service binding, Yjs Durable Object binding, existing secret bindings, and hourly `0 * * * *` Cron.
- Production D1 is `Akatuki-knowledge`. Read-only queries on 2026-10-20 returned 602 rows in `notes`, 8 in `telegram_notes`, zero `notes.sync_uuid IS NULL`, and three outbox jobs, all in `sent` state (no pending, processing, or dead jobs).
- The latest persisted safe-recovery diagnostic (2026-10-20 08:00:40 UTC) scanned 602 D1 notes and 602 Vault files: all 602 matched and were already aligned. It reported no missing Vault notes, tombstones, duplicate paths, UUID conflicts, or content conflicts. This verifies the reconciliation pass's recorded result, not every live request path.
- The `notes.sync_uuid` backfill completed for all 602 existing notes using the same deterministic UUID algorithm as the Worker. Note content was not changed. No initial bulk outbox enqueue was performed, to avoid recreating a Vault file that may have been independently deleted; existing Vault files receive stable frontmatter IDs through safe outbound updates.
- Staging live tests and evidence are recorded on [`evidence/yaos-staging-validation-20261020`](https://github.com/Akatuki1121/Akatuki-Knowledge/tree/evidence/yaos-staging-validation-20261020). The staging Workers were cleaned up after testing: secrets removed, public subdomains disabled, and schedules empty.
- Cloudflare API metadata confirms the active deployment, bindings, and Cron. A direct public HTTP smoke test and an end-to-end production mutation test have not been completed through the current execution path, so runtime request-level verification remains outstanding.

## Recovery limitations

- The exact historical SQL source for migrations `0001`–`0007` has not been recovered. The production D1 ledger contains those historical names, but the repository does not yet provide a verified clean-database migration chain.
- `migrations/0009_yaos_sync_jobs.sql` documents the production outbox schema extension. The reconstructed folders migration is kept under `migrations/pending/` because its DDL already existed in production before its ledger entry was reconciled.
- The recovered `wrangler.toml` reflects observed live settings and Durable Object migration tags `v1`–`v5`; the Cloudflare version API does not independently expose the full historical migration arrays.
- R2 is intentionally not configured.

## Development

Use Node.js and run:

```sh
npm run check
```

This verifies JavaScript syntax, sync-contract checks, sync identity/conflict tests, safe-note-ID recovery tests, and Wrangler configuration assertions. It does not validate Cloudflare bindings, Durable Object migration state, or live YAOS integration. A clean-database bootstrap remains a separate disaster-recovery task and must not be attempted against the existing production D1.
