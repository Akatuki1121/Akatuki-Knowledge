# D1 schema compatibility audit (static source check)

Date: 2026-10-19. Source under review: recovered `main/src/index.js`; schema under review: `schema-snapshots/live-d1-schema-2026-10-19.sql`.

## Results

- The captured schema declares 18 tables, including Cloudflare's internal `_cf_KV` and the Wrangler ledger tables.
- A static scan extracted 101 SQL string literals from calls to `prepare`, `exec`, and `batch`.
- Of these, 81 did not use a dynamic `${...}` interpolation in the SQL literal; 20 included interpolation and need additional review.
- For static INSERT column lists and UPDATE assignment targets whose table was recognized, no referenced column was absent from the captured table definition.
- Dynamic table-name paths were separately checked for `notes` and `telegram_notes`; the INSERT/UPDATE columns in those paths are present in both table definitions.
- The baseline bootstrap test passed on GitHub Actions run https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39210424724.

## Limits

This is a targeted static check, not a full SQL parser or runtime integration test. It does not establish correctness of every SELECT expression, JOIN, conflict clause, dynamically assembled SQL statement, data invariant, or Cloudflare D1 behavior. It does not test a staging Worker or a live request. No production D1 or Worker changes were made for this audit.

Event-sync schema proposals such as `notes.sync_uuid` and `yaos_sync_jobs` remain excluded because they are absent from the captured live schema.
