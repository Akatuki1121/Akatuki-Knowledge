# YAOS event sync

## Production status (2026-10-20)

The YAOS event-sync implementation was merged through PR [#14](https://github.com/Akatuki1121/Akatuki-Knowledge/pull/14) and is deployed to the production `akatuki-knowledge` Worker. Cloudflare Workers Builds may create a new deployment after each merge to `main`, including documentation-only changes, so deployment version IDs are intentionally not pinned here. Check the current deployment and traffic split in the Cloudflare dashboard or API when verifying production. The configured Cron is `0 * * * *` (hourly). The existing YAOS Worker and its Durable Object protocol were not changed (YAOS Worker and its Durable Object protocol unchanged).

Read-only production checks on 2026-10-20 found:

- D1 contains 602 Obsidian notes and 8 Telegram notes.
- All 602 Obsidian notes have a non-null `sync_uuid`.
- The outbox contains three jobs, all `sent`; there were no pending, processing, or dead-letter jobs at the time of the query.
- The latest persisted safe-recovery diagnostic scanned 602 D1 notes and 602 Vault files. All 602 were matched and already aligned; it reported no missing Vault notes, tombstones, duplicate paths, UUID conflicts, or content conflicts.

These checks confirm the current configuration and recorded reconciliation result. They do not prove every live mutation path works end to end. A direct public HTTP smoke test and a production mutation round-trip test remain outstanding.

## Event path

1. A Telegram note is created or appended, or a note is corrected, deleted, or restored through the API.
2. Akatuki Knowledge records an immutable outbox event with a note snapshot and expected previous revision.
3. A short background drain attempts immediate delivery after Telegram/API operations.
4. Events for the same note are applied in order; later events cannot bypass an earlier pending or processing event.
5. Transient failures are retried with exponential backoff. After eight attempts they become `dead`; permanent conflicts and unsafe payloads are dead-lettered immediately. Expired processing leases can be reclaimed.
6. The hourly scheduled run drains pending events before pulling changes from YAOS, then runs the existing Vault-to-D1 pull and scheduled maintenance. This ordering prevents stale Vault content from overwriting queued Akatuki Knowledge edits.

## Identity and note paths

- Existing Obsidian notes retain their current D1 row ID. A valid YAML `id:` UUID reconciles a moved Vault path to that same row; legacy notes without a valid UUID continue to use the path. Duplicate UUIDs fail closed with HTTP 409.
- Telegram notes retain their stable D1 ID. Their Vault path is derived from the title plus a 16-character hash of that ID, so a title change updates the same Vault note instead of creating a duplicate.
- Notes written by the event path receive a deterministic UUID in YAML `id:` frontmatter if they do not already contain a valid UUID. Telegram and Obsidian IDs use separate seeds. Existing valid UUIDs are preserved; a non-UUID `id:` value is replaced because this field is reserved for sync identity.
- Create, rename, delete, and restore operations maintain YAOS `meta`, `idToText`, and `pathToId`. Deletions are represented as YAOS metadata tombstones. Archived rows are always enqueued as deletes, even if a stale caller labels them as upserts. A YAOS tombstone is revived only through the explicit D1 restore path.
- Before overwriting a live Vault note, the worker compares its content with the desired content and expected previous revision. Independent Vault edits cause a fail-closed `vault_content_conflict` instead of being overwritten. The sync UUID frontmatter line is ignored for this comparison. Every successful delivery is followed by a read-back verification; a job is marked `sent` only after verification succeeds.

## Monitoring

The authenticated `GET /sync/status` endpoint reports pending, processing, sent, and dead-letter outbox counts. If the outbox migration is absent in an environment, the endpoint reports that condition instead of failing the whole status request.

## Migration and recovery safety

- The additive outbox schema is applied in production and recorded by `migrations/0009_yaos_sync_jobs.sql`.
- The reconstructed folders migration remains under `migrations/pending/` because the DDL existed in production before its ledger entry was reconciled.
- The exact historical SQL for migrations `0001`–`0007` has not been recovered byte-for-byte. The repository therefore does not yet provide a verified clean-database migration chain. Do not use a clean-database bootstrap against the existing production D1.
- No initial bulk outbox enqueue was performed for the 602 existing notes, to avoid recreating Vault files that may have been independently deleted. Safe reconciliation confirmed those notes already aligned, and stable frontmatter IDs were restored without changing note bodies.
- R2 is intentionally not configured. YAOS Worker source/configuration was not modified as part of this rollout.

## Validation status and remaining work

- The isolated integration suite `scripts/test_yaos_worker_integration.mjs` exercises the Knowledge Worker against a disposable local D1 database and the pinned YAOS Worker/Durable Object/WebSocket stack. The recorded GitHub Actions run [39339277481](https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39339277481) passed create, update, rename, delete, restore, transient-auth retry, independent Vault edit, and conflict-refusal cases. It uses a random vault ID and token and does not call production bindings or deploy either Worker.
- A staging validation branch and its evidence are available at [`evidence/yaos-staging-validation-20261020`](https://github.com/Akatuki1121/Akatuki-Knowledge/tree/evidence/yaos-staging-validation-20261020). Staging Workers were cleaned up after the tests.
- The automatic organizer currently updates metadata rather than note bodies, so metadata-only changes do not create Vault writes.
- Still outstanding: direct public HTTP smoke test, a production-safe request-level test of the deployed Worker, and continued observation of outbox outcomes after real user edits. Do not manufacture test notes or mutate production Vault content solely to claim these checks passed.
