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

### Authoritative identity (target design)

- The authoritative identity is the UUID stored in Akatuki Knowledge D1 as `notes.sync_uuid`. YAOS metadata is not the source of truth for identity.
- The sync identity is transport/storage metadata and must not be written into the Markdown body or YAML frontmatter. Obsidian remains the editing client; users and other AI agents must be able to create and edit ordinary notes without managing IDs.
- Akatuki Knowledge must persist the mapping `YAOS fileId ↔ notes.sync_uuid`. YAOS's stable `fileId` is retained when the same file is renamed and re-registered at a new path. YAOS `pathToId` represents current path mappings only and is not historical rename evidence. YAOS itself and its protocol are out of scope for changes.
- When resolving an identity, `notes.sync_uuid` takes precedence over any legacy frontmatter `id`. A frontmatter ID may be inspected only as migration-era evidence; it must not override a known D1 identity or be newly written to note content.
- This identity-separation work covers Obsidian notes only. Telegram notes and Telegram identity reconciliation are explicitly out of scope and must not be reintroduced into this migration.

### Incoming-file classification

Classify from the positive conditions that prove a file is new, not merely from the absence of a match.

1. **Known identity / update:** an unambiguous persisted `fileId ↔ sync_uuid` mapping resolves to one D1 note. Update that note while preserving its revision and conflict checks.
2. **Confirmed new note:** the current YAOS observation is complete and healthy; the file has a newly observed stable `fileId`; no existing mapping or other strong identity evidence points to a D1 note; there is no relevant unresolved deletion/move/tombstone, pending sync operation, duplicate identity, or conflicting mapping. Create a D1 note and assign a new random UUID in `notes.sync_uuid`; persist the mapping atomically with the identity decision.
3. **Deferred observation:** a scan or required metadata is incomplete, temporarily unavailable, or inconsistent in a way that may clear on retry. Do not create a D1 note or send the case to user review yet; re-observe safely.
4. **Ambiguous identity (`needs_review`):** the observation is complete, but evidence cannot distinguish a rename/move from a copy followed by deletion, or multiple candidate notes/mappings remain. Do not create, merge, or overwrite automatically.
5. **Identity conflict:** duplicate UUIDs, one-to-many mappings, or contradictory authoritative records must fail closed. Do not choose a winner or overwrite another note.

A global unrelated deletion must not block every genuinely new file. Only a deletion, tombstone, or missing prior path that plausibly relates to the incoming file is a reason to defer or review it. Likewise, content similarity is only a diagnostic hint: it is not proof of identity and its absence is not proof of newness. If the original still exists and a second file appears with a different stable `fileId`, treat it as a new copy unless stronger contradictory identity evidence exists.

During initial reconciliation, first establish mappings for existing D1 notes using available strong evidence. Only then classify unmatched files under the same confirmed-new conditions. An unmatched file in an incomplete first scan is not automatically new. Do not bulk-create all unmatched files merely because no current path mapping exists.

## Monitoring

The authenticated `GET /sync/status` endpoint reports pending, processing, sent, and dead-letter outbox counts. `GET /sync/outbox?status=dead&limit=50` lists individual jobs (job ID, entity/note ID, operation, state, attempts, timestamps, and last error) without returning `payload_json`, which can contain note content. Pagination uses the `before` job ID cursor. `POST /sync/outbox/{jobId}/retry` requeues only a `dead` job; it preserves the attempt count and last error for diagnosis and starts a bounded background drain. All three endpoints require the existing Bearer API token. If the outbox migration is absent in an environment, listing reports that condition instead of failing the whole status request.

## Identifier separation implementation status

The identity-separation implementation is on the dedicated follow-up branch and is not part of PR #145. Its additive D1 schema remains under `migrations/pending/`; do not deploy it or apply it to production as part of this PR.

1. `notes.sync_uuid` is authoritative for Akatuki-owned notes. The additive `yaos_file_identity_map` table uniquely binds YAOS's stable `fileId`, D1 `sync_uuid`, and D1 note ID. Mapping conflicts fail closed; mapping writes are checked by reading them back.
2. Outbound sync uses D1 `notes.sync_uuid` first. A conflicting legacy frontmatter ID is rejected rather than silently adopted. Telegram identity behavior is unchanged and out of scope.
3. Incoming YAOS observations establish mappings for known D1 notes before classifying unmatched files. Creation requires a complete observation and no mapping/path/tombstone/pending-job/UUID conflict. Incomplete observations are `deferred`; complete but ambiguous observations are `needs_review`. Similar content does not merge notes.
4. Existing revision creation, per-note outbox ordering, tombstone/restore operations, expected-content conflict refusal, and YAOS read-back verification remain in place. The isolated integration test covers create, edit, rename, delete, restore, retry after a local transient auth failure, and conflict refusal.

Authenticated `GET /sync/identity-map?noteId=...` exposes one note's mapping for diagnostics. `GET /sync/identity-review?classification=deferred|needs_review&limit=...` lists bounded review cases without returning note bodies.

The separate existing-note migration is not included. When explicitly authorized in the future, it must run `restore-all → verify → organize` in that order. No YAOS source/protocol change, production deploy, or direct production D1 write is part of this branch.

## Migration and recovery safety

- The additive outbox schema is applied in production and recorded by `migrations/0009_yaos_sync_jobs.sql`.
- The reconstructed folders migration (`migrations/0008_folders_schema_reconstructed.sql`) is recorded in the production ledger (2026-10-20). The DDL existed in production before that; it must not be re-run. Migrations that are not yet applied belong in `migrations/pending/`, which blocks the GitHub Actions production deploy while it holds any SQL.
- The exact historical SQL for migrations `0001`–`0007` has not been recovered byte-for-byte. The repository therefore does not yet provide a verified clean-database migration chain. Do not use a clean-database bootstrap against the existing production D1.
- No initial bulk outbox enqueue was performed for the 602 existing notes, to avoid recreating Vault files that may have been independently deleted. Safe reconciliation confirmed those notes already aligned, and stable frontmatter IDs were restored without changing note bodies.
- Frontmatter ID backfill during safe reconciliation was discontinued by owner decision (2026-10-26): reconciliation now only counts Vault files whose frontmatter has no ID (`missingFrontmatterId`) and never writes one. Existing frontmatter `id:` lines are removed by the authenticated `POST /sync/strip-frontmatter-ids` operation (dry-run by default; `?apply=1` applies, `limit` caps one call). It rewrites a Vault file only when the current text still matches the scanned text, verifies by re-reading, and strips the ID line from the D1 `notes.content` copy at the same time so an outbox upsert cannot write the ID back.
- The test rows created by the Issue #91 measurement sessions remain only in D1 `telegram_notes` (no Vault files) and are archived by the authenticated one-off `POST /sync/cleanup-measurement-notes` operation (dry-run by default; `?apply=1` applies). Scope is fixed to rows whose trailing `tg:<chat_id>:<update_id>` segment falls in the measurement ranges (update_id 9100001037–9100001072 and 9100002001–9100002036), so real-use rows can never match. Archiving sets `deleted_at` with `ai_allowed = 0` and `review_state = 'deleted'`, the same soft-delete shape as the note deletion path, which removes the rows from search.
- R2 is intentionally not configured. YAOS Worker source/configuration was not modified as part of this rollout.

## Validation status and remaining work

- The isolated integration suite `scripts/test_yaos_worker_integration.mjs` exercises the Knowledge Worker against a disposable local D1 database and the pinned YAOS Worker/Durable Object/WebSocket stack. The recorded GitHub Actions run [39339277481](https://github.com/Akatuki1121/Akatuki-Knowledge/actions/runs/39339277481) passed create, update, rename, delete, restore, transient-auth retry, independent Vault edit, and conflict-refusal cases. It uses a random vault ID and token and does not call production bindings or deploy either Worker.
- A staging validation branch and its evidence are available at [`evidence/yaos-staging-validation-20261020`](https://github.com/Akatuki1121/Akatuki-Knowledge/tree/evidence/yaos-staging-validation-20261020). Staging Workers were cleaned up after the tests.
- The automatic organizer currently updates metadata rather than note bodies, so metadata-only changes do not create Vault writes.
- Still outstanding: direct public HTTP smoke test, a production-safe request-level test of the deployed Worker, and continued observation of outbox outcomes after real user edits. Do not manufacture test notes or mutate production Vault content solely to claim these checks passed.
