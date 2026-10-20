# YAOS event sync - Cloudflare staging validation (2026-10-20)

Evidence for PR #14 (`feature/yaos-event-sync-clean-base`, commit 2082497). Staging only; no production resources were touched.

- `staging-verify.mjs` - pass 1: create, update, rename, delete, restore, retry, conflict (log: `staging-run.log`, results: `staging-results.json`)
- `staging-verify2.mjs` - pass 2: clean delete tombstone, restore and conflict re-run on a second note (log: `staging-run2.log`, results: `staging-results2.json`)
- `setup-secrets.ps1` - generates random staging-only tokens and sets staging Worker secrets (token values are never printed or stored in this repo)

Staging outbox after the run (`yaos_sync_jobs`): jobs 1-6, 9-11 `sent` (job 6 with attempts=2 after the temporary auth failure); jobs 7, 8, 12 `dead` with `vault_content_conflict`.

The scripts expect a local `.stg.json` with `API_TOKEN`, `SYNC_TOKEN`, `VAULT_ID` and hard-coded local paths; they are evidence, not a reusable test suite. Staging secrets were deleted and public URLs disabled after the run.