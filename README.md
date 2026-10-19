# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Recovered deployed Worker

`src/index.js` is the JavaScript module extracted from the currently deployed Cloudflare Worker. The recovered module matches the executable content of the deployed bundle; the deployed response additionally appends a source-map annotation. It is preserved as a single bundled entrypoint because the original modular source files and source map were not recovered.

## Recovery status

- The active Worker module has been recovered into a normal JavaScript file on the recovery branch.
- The live D1 schema and migration ledger have been captured under `schema-snapshots/` for compatibility checks only. The existing production D1 is to be preserved; these snapshots are not executable migrations and must not be replayed.
- Observed Cloudflare configuration and unresolved recovery steps are recorded in `docs/CLOUDFLARE_RECOVERY.md`.
- The original D1 migration SQL `0001`–`0007` and exact Durable Object migration declarations for tags `v1`–`v5` remain missing. The missing D1 SQL is a disaster-recovery gap, not a reason to rebuild the current database. The old `migrations/0001_initial.sql` snapshot has been moved out of the executable migrations directory.
- A verified `wrangler.toml` is intentionally not included yet; inventing Durable Object migration declarations could make a future deployment unsafe.
- `migrations/0008_yaos_sync_jobs.sql` exists only on the backup branch and is not applied to live D1. It is not included in this recovery PR.

## Development

Use Node.js and run:

```sh
npm ci
npm run check
```

The check verifies JavaScript syntax only. It does not validate Cloudflare bindings, Durable Object migration state, or database migrations.

**Do not deploy this recovery branch to production yet.** First review the two SQL compatibility fixes and recover/verify the exact Durable Object migration declarations. Keep the existing production D1 unchanged; a fresh-database bootstrap is a separate disaster-recovery task, not a prerequisite for preserving the current service.
