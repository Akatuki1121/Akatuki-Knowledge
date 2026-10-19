# Akatuki-Knowledge

Cloudflare Worker and D1-backed knowledge service.

## Recovered deployed Worker

`src/index.js` is the JavaScript module extracted from the currently deployed Cloudflare Worker. Its contents were compared with the deployed script on 2026-10-19: the extracted module matched the deployed module exactly (same source length and SHA-256/FNV check used during the comparison). The multipart upload envelope is not part of the source file and has been removed.

This is a **deployed bundle**, not the original modular authoring source. Keep it as a recovery baseline until the original source layout can be restored and tested.

## Current Cloudflare configuration observed during recovery

- Worker: `akatuki-knowledge`
- Compatibility date: `2026-10-17`
- Scheduled trigger: `0 * * * *` (hourly)
- D1 binding: `DB` → database `Akatuki-knowledge`
- Service binding: `YAOS` → service `yaos` (production)
- Durable Object binding: `YJS_CLIENT` → class `YjsClientDO`
- Plain-text variables: `GEMINI_LIGHT_MODEL`, `GEMINI_MODEL`, `ORGANIZE_PER_RUN`
- Secret bindings (names only; values are not stored here): `API_TOKEN`, `GEMINI_API_KEY`, `TELEGRAM_ALLOWED_CHAT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `VAULT_ID`, `YAOS_TOKEN`

## Recovery caveats

- The repository does not yet contain a verified `wrangler.toml` or `wrangler.jsonc`.
- The live D1 migration history contains `0001` through `0007`, but this repository's `main` branch does not contain the corresponding `0002`–`0007` migration files.
- `migrations/0001_initial.sql` must be checked against a genuinely fresh database before treating it as a reproducible initial migration.
- `migrations/0008_yaos_sync_jobs.sql` exists on a separate backup branch, but it is not recorded as applied in the live D1 database. Do not apply it as part of source recovery.
- Do not deploy from this recovery branch until the Worker configuration and migration history have been reconstructed and checked.

No Cloudflare Worker settings, secrets, or D1 data were changed as part of this source recovery.
