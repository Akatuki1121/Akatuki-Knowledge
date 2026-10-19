# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Recovered deployed Worker

`src/index.js` is the JavaScript module extracted from the currently deployed Cloudflare Worker. The extracted module matches the deployed module byte-for-byte after removing the multipart upload envelope. It is preserved as a single bundled entrypoint because the original modular source files and source map were not recovered.

## Recovery status

- The active Worker module has been recovered into a normal JavaScript file on the recovery branch.
- The live D1 schema and migration ledger have been captured under `schema-snapshots/`. These are documentary snapshots, not executable migrations.
- Observed Cloudflare configuration and unresolved recovery steps are recorded in `docs/CLOUDFLARE_RECOVERY.md`.
- The original D1 migration SQL `0001`–`0007` and exact Durable Object migration declarations for tags `v1`–`v5` remain missing. The old `migrations/0001_initial.sql` snapshot has been moved out of the executable migrations directory.
- A verified `wrangler.toml` is intentionally not included yet; inventing Durable Object migration declarations could make a future deployment unsafe.
- `migrations/0008_yaos_sync_jobs.sql` exists only on the backup branch and is not applied to live D1. It is not included in this recovery PR.

## Development

Use Node.js and run:

```sh
npm ci
npm run check
```

The check verifies JavaScript syntax and static sync-contract expectations. It does not validate Cloudflare bindings, Durable Object migration state, D1 migration application, or end-to-end Vault behavior.

**Do not deploy this recovery branch to production yet.** Recover the missing migration history and verify a fresh-database bootstrap plus a staging deployment first.
