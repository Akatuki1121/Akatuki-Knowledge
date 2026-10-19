# D1 schema compatibility audit (static source check)

Date: 2026-10-19. Baseline: recovered Worker source and captured D1 schema from before 2026-10-19 10:00 JST. Validation changes are isolated to `recovery/bootstrap-schema-validation`; `main` and production are unchanged.

## Results

- The captured schema declares 18 tables, including Cloudflare's internal `_cf_KV` and the Wrangler ledger tables.
- The first source scan found 101 SQL string literals. The CI SQL compiler now tests extracted SQL statements against the captured schema using SQLite `EXPLAIN`, with representative substitutions for dynamic table names.
- That check exposed two real SQL compatibility errors: two queries selected `path` from `telegram_notes`, whose captured schema has no `path` column. The recovery branch now selects `NULL AS path` for Telegram notes and keeps `path` for Obsidian notes. This is a targeted bug fix to the recovered source, not an exact byte-for-byte copy of the deployed Worker.
- The SQL compiler test also handles numbered SQLite parameters (for example `?1`) separately from anonymous `?` parameters to avoid false failures.
- The baseline bootstrap test validates a reconstructed clean SQLite schema; it is not a production migration and must not be applied to the live D1 database.

## Limits

This is a static compatibility check, not a complete JavaScript parser or Cloudflare D1 integration test. Dynamically assembled statements not extracted by the test, data-dependent constraints, request-path behavior, and actual Cloudflare runtime behavior still require additional validation. It does not test a staging Worker or a live request. No production D1 or Worker changes were made.

Event-sync schema proposals such as `notes.sync_uuid` and `yaos_sync_jobs` remain excluded because they are absent from the captured live schema.
