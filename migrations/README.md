# D1 migrations

The original applied migration SQL files `0001` through `0007` are not present in the recovered repository.

Do not create replacement files under these historical names by guessing. The file previously named `0001_initial.sql` was an evolved schema snapshot containing the `d1_migrations` table itself; it has been preserved under `../schema-snapshots/` and removed from this executable migration directory so that Wrangler cannot mistake it for a clean-database migration.

Current live schema reference: `../schema-snapshots/live-d1-schema-2026-10-19.sql`.

Before using `wrangler d1 migrations apply`, restore and validate the real ordered migration set against a fresh test database. The live D1 database has applied `0001` through `0007`; no production migration was run during this recovery.


The event-sync branch keeps `0008_yaos_sync_jobs.sql` under `migrations/pending/`. It is a proposed migration only and has not been applied to live D1. Do not move it into this executable directory until the original migration chain is restored and validated.
