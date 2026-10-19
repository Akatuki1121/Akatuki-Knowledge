# Live Cloudflare vs repository source comparison

Captured 2026-10-19 using read-only Cloudflare and GitHub API reads. This is a source/configuration comparison, not a deployment instruction.

## Active Akatuki Knowledge Worker

- Active version: 49, version ID `9f46f976-9f9e-4a7b-831b-f5e6d668b651`.
- Deployment ID: `9fb82e9a-c350-4ef4-8efe-9a44fa58c4ff`, created `2026-10-18T17:58:28.075243Z`.
- Compatibility date: `2026-10-17`.
- Bound D1: `Akatuki-knowledge`, ID `e8c57dbe-0175-43d8-9c16-0501e0c1d5a6`.
- Other non-secret configuration includes service binding `YAOS` → `yaos`, DO binding `YJS_CLIENT` → `YjsClientDO`, `GEMINI_MODEL=gemini-3.5-flash-lite`, `GEMINI_LIGHT_MODEL=gemini-3.1-flash-lite`, and `ORGANIZE_PER_RUN=2`. Secret values were not read/exported.
- The live Cron is `0 * * * *` (hourly).

## Code comparison

- Cloudflare's script-content API returned a multipart payload containing `wrapper.js`.
- Extracted live `wrapper.js`: 389,522 characters.
- GitHub `main/src/index.js`: 389,486 characters.
- The complete GitHub file matches the start of the live module exactly; the deployed bundle adds only `//# sourceMappingURL=wrapper.js.map\n` at the end.
- Thus `main/src/index.js` is a faithful recovery of the active executable module content, but not the original modular source/build inputs or source map.

## Scheduled pull mismatch

The live module defines `PULL_CRON = "*/5 * * * *"` and starts the YAOS pull only when `event.cron === PULL_CRON`. The configured live Cron is `0 * * * *`. Those values cannot match. The code/config evidence indicates the YAOS → D1 pull branch is not started by the configured scheduled trigger; this conclusion is an inference from code and settings, not a claim verified from execution logs.

The event-sync branch changes `PULL_CRON` to `0 * * * *`, preserving the observed hourly trigger, and adds an outbox path intended to send individual mutations promptly. The hourly pull remains reconciliation, not the primary sync mechanism. Neither the code change nor the event-sync path has been deployed.

## Production D1 policy

The existing production D1 must be kept and reused. The captured schema and migration ledger are compatibility references only. Do not recreate D1, restore Time Travel, import a schema snapshot, replay migrations, or run mutating SQL as part of this source/configuration recovery.

The event-sync branch adds `migrations/pending/0008_yaos_sync_jobs.sql` for `notes.sync_uuid` and the outbox table. It is not applied to production. Enabling the new code requires a separately reviewed additive migration and safe rollout; do not deploy the branch while it depends on missing columns/tables.

## Durable Object migration safety

Cloudflare version metadata records migration tags `v1`–`v5`, but does not expose the original Wrangler migration operations. Do not invent `new_classes`, rename/delete operations, or SQLite-class declarations. A production deployment remains blocked until the actual DO migration chain is recovered and validated.

## Actions taken

- Read Cloudflare Worker code/settings/deployment metadata and GitHub files.
- Confirmed the event-sync PR corrects the hourly Cron discriminator.
- No production Worker deployment, D1 mutation/recreation, migration replay, secret change, or Vault write was performed by this comparison.


## External YAOS Worker configuration (read-only observation)

The separately deployed `yaos` Worker was inspected through Cloudflare settings/version metadata on 2026-10-19:

- Active version ID: `18ae722f-ae97-40f9-bec4-7d127ae5477b`, created `2026-10-18T11:30:51.702769Z`.
- Compatibility date: `2026-03-02`.
- Durable Object binding `YAOS_CONFIG` → `ServerConfig`, namespace ID `bbb1227af8314a5393cdbfa9d0aefb69`.
- Durable Object binding `YAOS_SYNC` → `VaultSyncServer`, namespace ID `08a506977fec4448ad89d208fe236dc5`.
- No Cron schedules were configured for this Worker at the time of inspection.
- The deployed bundle reports `SERVER_SCHEMA_VERSION = 3`.

These are observed production settings, not a reconstructed source configuration. The source repository corresponding to this exact deployed bundle has not yet been verified. Do not change the YAOS Worker, its Durable Objects, or their data as part of this recovery. Do not treat the absence of a Cron trigger as a defect without confirming the intended YAOS execution model.
