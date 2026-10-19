# YAOS event sync

## Goal

Keep the existing YAOS Worker and its Durable Object protocol unchanged. Akatuki Knowledge writes changes to a D1 outbox; the existing `YJS_CLIENT` Durable Object binding applies those changes to the YAOS Vault and verifies the result.

## Observed production mismatch

The live Cloudflare Cron is `0 * * * *`, but the recovered production bundle checks `PULL_CRON = "*/5 * * * *"` before running the Vault pull. Those values do not match, so the intended pull branch is not selected by the configured hourly trigger. This branch changes the discriminator to the observed hourly schedule; that correction has not been deployed.

## Event path

1. A Telegram note is created or organized, or a note is corrected, deleted, or restored through the API.
2. Akatuki Knowledge records an immutable outbox event with the note snapshot.
3. A short background drain attempts immediate delivery after Telegram/API operations.
4. Each mutation gets its own queued event with the previous revision as its expected baseline. Events for the same note are applied in order; later events cannot bypass an earlier pending or processing event.
5. Failed transient events are retried with exponential backoff. After eight attempts they become `dead`; permanent conflicts and unsafe payloads are dead-lettered immediately. Expired processing leases can be reclaimed.
5. The hourly scheduled run drains pending events before pulling changes from YAOS, preventing stale Vault content from overwriting queued Akatuki Knowledge edits. It then runs the existing Vault-to-D1 pull and scheduled maintenance.

## Identity and note paths

- Existing Obsidian notes retain their current D1 row ID, but a valid YAML `id:` UUID is used to reconcile a moved Vault path back to that same row. The path remains the lookup key for legacy notes without a valid UUID. Duplicate UUIDs fail closed with HTTP 409 rather than silently merging or overwriting rows.
- Telegram notes retain their stable D1 ID. Their Vault path is derived from the title plus a 16-character hash of that ID, so a title change updates the same Vault note instead of creating a duplicate.
- Every note written by the event path receives a deterministic UUID in YAML `id:` frontmatter if it does not already contain a valid UUID. Telegram IDs and Obsidian-note IDs use separate seeds. Existing valid UUIDs are preserved; a non-UUID `id:` value is replaced because this field is reserved for sync identity.
- Create, rename, delete, and restore operations maintain YAOS `meta`, `idToText`, and `pathToId`. Deletions are represented as YAOS metadata tombstones, not by removing CRDT records outright. A row with `deleted_at` set is always enqueued as a delete, and the Durable Object treats any archived payload as a tombstone even if a stale caller labels it an upsert. A YAOS tombstone is not revived by ordinary edits; only the explicit D1 restore path may revive it.
- Before overwriting an existing live Vault note, the worker compares its content with the desired content and the expected previous revision. If the Vault has an independent edit, the job fails closed as `vault_content_conflict` instead of overwriting it. The sync UUID frontmatter line is ignored for this comparison. Every successful delivery is followed by a read-back verification. A job is marked `sent` only after verification succeeds.

## Monitoring\n\nThe authenticated `GET /sync/status` response includes pending, processing, sent, and dead-letter outbox counts. If the pending migration is not present, the response reports that the outbox table is not migrated rather than failing the entire status request.\n\n## Migration safety

The D1 outbox migration is intentionally stored under `migrations/pending/`, not the executable migrations directory. The original migration SQL for 0001-0007 is missing from the recovered repository. Do not deploy this Worker version until the outbox table has been applied to the live D1 database and the migration chain has been validated. This feature branch does not change production Worker code, D1 data, secrets, or YAOS.

## Scope and remaining checks

The outbox is wired to Telegram note creation, conversation capture/append, undo, and the existing API correction, delete, and restore operations. The automatic organizer currently updates metadata rather than note bodies, so those metadata-only updates do not create Vault writes. The `syncNotes` import now uses UUIDs to reconcile path changes without creating duplicate D1 rows, and refuses ambiguous UUID matches. A safe UUID backfill for existing Vault notes is still not implemented. A broader mutation audit and end-to-end staging tests remain required before claiming complete sync coverage. Dead-letter events remain available for inspection, but do not permanently block newer events; newer events still have to pass the content-baseline conflict check. The hourly Vault pull remains the repair path for YAOS-to-D1 changes; bidirectional behavior still needs staging validation.
