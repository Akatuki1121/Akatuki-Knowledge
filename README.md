# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Recovered deployed Worker

`src/index.js` is the JavaScript module extracted from the active Cloudflare Worker. The deployed `wrapper.js` content matches the GitHub `main/src/index.js` content, with a trailing source-map annotation added by the deployed bundle. The original modular source files and source map were not recovered, so the deployed module remains a bundled entrypoint.

## Recovery status

- The current Worker code, compatibility date, bindings, non-secret variables, and hourly Cron have been compared with the read-only Cloudflare configuration.
- The live D1 schema and migration ledger are captured under `schema-snapshots/` as reference material for compatibility checks. **The existing production D1 is to be retained and reused.** No rebuild, restore, import, or replay of migrations is part of this recovery.
- The deployed code checks `PULL_CRON = "*/5 * * * *"` while the live Cron is `0 * * * *`. The event-sync branch corrects the code to the observed hourly schedule and adds an outbox-based event path; neither change has been deployed.
- The event-sync branch's additive D1 migration `migrations/pending/0008_yaos_sync_jobs.sql` remains pending. It has not been applied to production.
- Original D1 migration SQL `0001`–`0007` and exact Durable Object migration declarations for tags `v1`–`v5` remain unrecovered. The original DO migration operations must be recovered before deploying a new Worker configuration.
- `backup/codespaces-20261019-040712/src/index.js` contains the multipart upload envelope, not a clean JS module. Its extracted `wrapper.js` matches the deployed module; do not treat the envelope itself as source.

See [Cloudflare recovery notes](docs/CLOUDFLARE_RECOVERY.md), [live-vs-repository comparison](docs/CLOUDFLARE_LIVE_VS_REPOSITORY_DIFF.md), and [YAOS event-sync contract](docs/YAOS_EVENT_SYNC.md).

## Development

Use Node.js and run:

```sh
npm ci
npm run check
```

The checks cover syntax, static sync contracts, identity/path-move behavior, and configuration assertions. They do not establish end-to-end YAOS WebSocket correctness or production readiness.

**Do not deploy this branch yet.** The current D1 should remain in place. Before deployment, review conflict protection and mutation coverage, recover exact Durable Object migration declarations, and validate the additive migration against an isolated staging database. A clean-database bootstrap is a separate disaster-recovery task, not a prerequisite for keeping the live D1.
