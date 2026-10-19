# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Recovered deployed Worker

`src/index.js` is the JavaScript module extracted from the currently deployed Cloudflare Worker. The recovered module matches the executable content of the deployed bundle; the deployed response additionally appends a source-map annotation. It is preserved as a single bundled entrypoint because the original modular source files and source map were not recovered.

## Recovery status

- The active Worker module has been recovered into a normal JavaScript file on the recovery branch.
- The live D1 schema and migration ledger have been captured under `schema-snapshots/` for compatibility checks only. The existing production D1 is to be preserved; these snapshots are not executable migrations and must not be replayed.
- Observed Cloudflare configuration and remaining recovery steps are recorded in `docs/CLOUDFLARE_RECOVERY.md`.
- The byte-level comparison with the live Worker, the backup branch artifact, and the cron/code mismatch are documented in `docs/CLOUDFLARE_LIVE_VS_REPOSITORY_DIFF.md`.
- A local Wrangler configuration was recovered with Durable Object migration declarations for `v1`–`v5`. A reconstruction is preserved in `wrangler.toml` on this recovery branch, with the current recovered source entrypoint and observed live bindings/settings. Review the file and run Wrangler's configuration validation before any deployment.
- The migration declarations are grounded in the recovered local configuration and the live Worker’s observed `v5` tag. The version API does not expose the original migration arrays, so this is a strong recovery artifact, not independent proof of every historical deployment operation.
- The original D1 migration SQL `0001`–`0007` is still missing. This is a disaster-recovery gap, not a reason to rebuild the current database. The old `migrations/0001_initial.sql` snapshot has been moved out of the executable migrations directory.
- `migrations/0008_yaos_sync_jobs.sql` exists only on the backup branch and is not applied to live D1. It is not included in this recovery branch.
- R2 is intentionally not configured; its removal was previously confirmed as intentional.

## Development

Use Node.js and run:

```sh
npm run check
```

The check verifies JavaScript syntax only. It does not validate Cloudflare bindings, Durable Object migration state, or database migrations.

**Do not deploy this recovery branch to production yet.** Validate the Wrangler config and review the existing SQL compatibility fixes first. Keep the existing production D1 unchanged; a fresh-database bootstrap is a separate disaster-recovery task, not a prerequisite for preserving the current service.
