# YAOS event sync - Cloudflare staging validation (2026-10-20)

Evidence for PR #14 (`feature/yaos-event-sync-clean-base`, commit 2082497). Staging only; no production resources were touched.

- `staging-verify.mjs` - pass 1: create, update, rename, delete, restore, retry, conflict (log: `staging-run.log`, results: `staging-results.json`)
- `staging-verify2.mjs` - pass 2: clean delete tombstone, restore and conflict re-run on a second note (log: `staging-run2.log`, results: `staging-results2.json`)
- `setup-secrets.ps1` - generates random staging-only tokens and sets staging Worker secrets (token values are never printed or stored in this repo)

Staging outbox at the end of the two recorded runs (`yaos_sync_jobs`): jobs 1-6 and 9-11 `sent` (job 6 with attempts=2 after the temporary auth failure); jobs 7, 8, 12 `dead` with `vault_content_conflict`. A subsequent direct read of staging D1 also found job 13 (`telegram_notes` upsert, `tg:1000000001:3`) created at 2026-10-20T04:48:12Z and sent at 05:01:03Z. This job is not represented in the two logs and its trigger has not been established; final observed outbox state was 10 `sent`, 3 `dead`, 0 `pending`.

Post-run cleanup was re-applied and verified via Cloudflare API after a later read found the staging state did not match this README: all secrets removed from both staging Workers, both `workers.dev` subdomains disabled, and the Knowledge staging Cron list emptied. The final verified settings were empty secrets/schedules and `enabled=false` for both subdomains. The scripts expect a local `.stg.json` with `API_TOKEN`, `SYNC_TOKEN`, `VAULT_ID` and hard-coded local paths; they are evidence, not a reusable test suite. Local temporary folders were not inspected during this cleanup.