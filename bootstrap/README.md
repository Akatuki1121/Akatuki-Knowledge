# Reconstructed clean-database baseline (recovery only)

This SQL is reconstructed from `schema-snapshots/live-d1-schema-2026-10-19.sql`; it was **not** recovered from original migration history.

- It is not an original `0001_initial.sql` and must not be represented as one.
- It lives outside `migrations/` so Wrangler's normal migration workflow will not pick it up.
- Never apply it to the existing production D1 database. Production already records migrations `0001`–`0007`.
- It excludes Cloudflare's internal `_cf_KV` table and Wrangler-managed `d1_migrations` ledger.
- The test creates this schema in an empty, in-memory SQLite database. It does not prove full Worker runtime compatibility and does not replace a Cloudflare D1 staging test.
- Event-sync additions such as `notes.sync_uuid` and `yaos_sync_jobs` are excluded because they are absent from the captured live schema.
