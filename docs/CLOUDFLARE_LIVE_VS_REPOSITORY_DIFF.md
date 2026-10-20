# Live Cloudflare vs repository source comparison

Captured 2026-10-19 from read-only Cloudflare and GitHub API reads. This is a comparison record, not a deployment instruction.

## Akatuki Knowledge Worker code

- Cloudflare active version: 49, version ID `9f46f976-9f9e-4a7b-831b-f5e6d668b651`.
- The live script-content API returns a multipart payload containing `wrapper.js`.
- Extracted live `wrapper.js`: 389,522 characters.
- GitHub `main/src/index.js`: 389,486 characters.
- The entire GitHub file matches the beginning of the live `wrapper.js` exactly. The only trailing difference is the deployed bundle's source-map annotation:
  `//# sourceMappingURL=wrapper.js.map\n`
- This establishes that `main/src/index.js` preserves the deployed executable module content observed at capture time. It does not recover the original modular source files, build setup, source map, or Wrangler configuration.

## Recovery-branch source difference

The branch `recovery/bootstrap-schema-validation` has two deliberate changes relative to `main/src/index.js`:

1. In the query near line 615, select `path` for the `notes` table and `NULL AS path` for `telegram_notes`.
2. The same adjustment in the query near line 969.

Reason: `telegram_notes` has no `path` column in the captured live D1 schema. The compatibility test exposed these invalid SQL variants. The fix is only in the recovery branch; it has not been deployed. Static SQLite `EXPLAIN` tests are not a full live D1 integration test, so the fix still requires review before any deployment.

## Configuration and database

- The deployed Worker uses the existing D1 binding `DB` to database `Akatuki-knowledge` (ID `e8c57dbe-0175-43d8-9c16-0501e0c1d5a6`).
- The checked `main` branch has no `wrangler.toml` or `wrangler.jsonc` at the repository root. Do not infer the original Durable Object migration declarations from version tags alone.
- **The live D1 is to be preserved and reused.** This recovery does not require recreating it, replaying migrations, importing a schema snapshot, or restoring Time Travel. Schema snapshots are reference material for compatibility checks only.
- The original D1 migration SQL files `0001`–`0007` remain unrecovered. Because the existing database is being retained, that gap is not a prerequisite for comparing/recovering Worker source. It matters for disaster recovery or building a separate clean database.
- Exact Durable Object migration declarations remain a deployment-safety blocker: no reconstructed Wrangler config should be deployed until those operations are verified.

## Actions taken

- Read current Cloudflare Worker source/settings/deployment metadata and GitHub source.
- Kept the code comparison and compatibility fix on `recovery/bootstrap-schema-validation`.
- No production Worker deployment, D1 mutation, D1 recreation, or migration replay was performed by this comparison.

## Backup-branch artifact and scheduled-sync mismatch

- `backup/codespaces-20261019-040712/src/index.js` is not a clean JavaScript source file: it contains the complete multipart upload envelope around `wrapper.js`. After extracting the payload, it matches the deployed module / `main/src/index.js` exactly, including the deployed source-map annotation. Keep the extracted `main/src/index.js` as source; do not run the multipart-wrapped backup file as Worker code.
- The deployed Worker configuration has a scheduled trigger of `0 * * * *` (hourly). The deployed code defines `PULL_CRON = "*/5 * * * *"` and calls the YAOS pull only when `event.cron === PULL_CRON`. With the currently observed hourly trigger, that equality will not match; the handler falls through to `worker_default.scheduled`. **Code/config analysis therefore indicates the scheduled YAOS→D1 pull is not being started by the configured cron.** This is an inference from the retrieved config and code, not a claim based on live execution logs. Do not change production scheduling as part of source recovery; decide the intended sync mechanism and interval separately.
