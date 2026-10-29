# YAOS event sync

## Production status (2026-10-20)

The YAOS event-sync implementation was merged through PR [#14](https://github.com/Akatuki1121/Akatuki-Knowledge/pull/14) and is deployed to the production `akatuki-knowledge` Worker. Cloudflare Workers Builds may create a new deployment after each merge to `main`, including documentation-only changes, so deployment version IDs are intentionally not pinned here. Check the current deployment and traffic split in the Cloudflare dashboard or API when verifying production. The configured Cron is `0 * * * *` (hourly). The existing YAOS Worker and its Durable Object protocol were not changed (YAOS Worker and its Durable Object protocol unchanged).

Read-only production checks on 2026-10-20 found:

- D1 contains 602 Obsidian notes and 8 Telegram notes.
- All 602 Obsidian notes have a non-null `sync_uuid`.
- The outbox contains three jobs, all `sent`; there were no pending, processing, or dead-letter jobs at the time of the query.
- The latest persisted safe-recovery diagnostic scanned 602 D1 notes and 602 Vault files. All 602 were matched and already aligned; it reported no missing Vault notes, tombstones, duplicate paths, UUID conflicts, or content conflicts.

These checks confirm the current configuration and recorded reconciliation result. They do not prove every live mutation path works end to end. A direct public HTTP smoke test and a production mutation round-trip test remain outstanding.

## Pull triggers and failure visibility (repository change, not yet deployed)

The scheduled Vault-to-D1 pull stays hourly (`0 * * * *`): day-to-day synchronisation between devices is handled by YAOS itself, so the scheduled pull is only a safety net for missed changes. Prompt convergence after an AI edit session comes from the post-write pull instead (see Event path item 3): when a write's chained drain delivers at least one job, one pull runs immediately, subject to a 120-second cooldown. Every pull outcome — scheduled, post-write, and manual (`POST /sync/pull`) — is persisted to `app_meta` as `vault_pull_latest`, tagged with a `source` field, and exposed through `GET /sync/status` as described in Monitoring. This change is implemented in the repository only; production still runs the previously deployed configuration until it is reviewed, merged, and deployed through the normal gate.

## Event path

1. A Telegram note is created or appended, or a note is corrected, deleted, or restored through the API.
2. Akatuki Knowledge records an immutable outbox event with a note snapshot and expected previous revision.
3. A background drain attempts immediate delivery after API write operations (note create, correction, delete, restore, outbox retry, and identity repair). The post-write drain is chained: it drains in batches of 20 and keeps going while a batch comes back full, up to 5 batches (100 jobs) per write, so a bulk rewrite is not left waiting for the scheduled drain after the first few jobs. Anything beyond the cap is picked up by the scheduled drain. When the chained drain delivers at least one job, one Vault pull (apply) runs immediately afterwards, so the vault-side state converges into D1 at the end of an AI edit session rather than at the next hourly pull. A 120-second cooldown tracked in `app_meta` coalesces a burst of writes into at most one post-write pull per window, and the drain result reports whether the pull ran or why it was skipped (no delivered jobs, or cooldown). A failed post-write pull is recorded and logged but never fails the write itself.
4. Events for the same note are applied in order; later events cannot bypass an earlier pending or processing event.
5. Transient failures are retried with exponential backoff. After eight attempts they become `dead`; permanent conflicts and unsafe payloads are dead-lettered immediately. Expired processing leases can be reclaimed.
6. The hourly scheduled run drains pending events before pulling changes from YAOS, then runs the existing Vault-to-D1 pull and scheduled maintenance. This ordering prevents stale Vault content from overwriting queued Akatuki Knowledge edits.

### Atomicity of note writes and outbox events

For API note creation, correction, deletion, and restoration, the D1 note mutation and its outbox event are committed in a single `env.DB.batch`, so the two can never diverge: there is no state where the API reports failure but D1 has moved on without an event, or where a committed mutation has no event to deliver. Each handler prepares the event against a snapshot of the post-mutation row before the batch runs (`prepareSyncJob` in `src/sync-outbox.mjs`); identity resolution and conflict validation happen at that point, so an identity conflict fails the request before any write is committed. For deletion and restoration the job insert is additionally guarded on the row state the mutation must produce (`deleted_at` set by this request, or cleared with this request's `updated_at`), so if a concurrent write wins the race and the mutation changes nothing, no orphan event is recorded.

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

The authenticated `GET /sync/status` endpoint reports pending, processing, sent, and dead-letter outbox counts. It also returns a `pull` field: the latest Vault pull outcome persisted in `app_meta` (`vault_pull_latest`), with the run timestamp (`recordedAt`), a `source` field (`scheduled`, `post_write`, or `manual`), `ok`, applied/count fields, and — on failure — a sanitized error code or safe failure description. A failed pull is also emitted as a structured `console.error` log line. This is the owner-visible failure signal for the pull; no external notification channel is used (Telegram alerts were removed). If no pull has been recorded yet, `pull` reports `skipped: "no_pull_recorded"`. `GET /sync/outbox?status=dead&limit=50` lists individual jobs (job ID, entity/note ID, operation, state, attempts, timestamps, and last error) without returning `payload_json`, which can contain note content. Pagination uses the `before` job ID cursor. `POST /sync/outbox/{jobId}/retry` requeues only a `dead` job; it preserves the attempt count and last error for diagnosis and starts a bounded background drain. All three endpoints require the existing Bearer API token. If the outbox migration is absent in an environment, listing reports that condition instead of failing the whole status request.

Identity review rows are a live work queue, not a ledger: a row disappears when its case resolves. Resolution normally happens when the file re-enters a pull's candidate list and imports cleanly. A `vault_pull_live_content_conflict` row can also converge from the D1 side — a correction, or a delivered outbox update, makes D1 hold the vault content — after which the note stops differing and never becomes a candidate again. To keep such rows from lingering forever, each vault pull with a complete observation re-checks the rows recorded for that reason and drops a row when the uniquely mapped D1 note is live, sits at the observed path, holds exactly the observed content hash, and has no outbox operation in flight. Rows recorded for any other reason describe identity problems, which identical content cannot resolve, and are never dropped by this pass. The number of rows dropped this way is returned as `resolvedReviews` and included in the persisted pull summary.

## Path-mismatch fossil removal (repository change, not yet deployed)

One YAOS conflict file is stuck as a live vault entry even though the owner deleted it on every device: its D1 row is archived with `id` set to the history path while the row's `path` column points at the Inbox path, and the identity map still binds the note under a conflicting mapping. The archived-rebind repair requires `id === path`, and a normal outbox delete dead-ends in `sync_identity_mapping_conflict`, so neither existing path can remove the entry. The authenticated `POST /sync/remove-vault-fossil` endpoint covers exactly this one allowlisted entry (history path, live `fileId`, and expected content hash are fixed in code). It first verifies, without changing anything, that the vault entry's current content hash matches the allowlisted hash and that the archived D1 row preserves identical content (stored hash and recomputed hash), and it supports `dryRun: true` to return the target and these checks only. On apply, the Durable Object re-verifies path, `fileId`, and content hash inside the vault document before tombstoning the entry with the same fields the knowledge-sync delete path writes, then the Worker deletes the note's `yaos_file_identity_map` and `yaos_sync_identity_review` residue and re-verifies all three. The archived D1 row is never modified, and any precondition mismatch aborts the repair with no changes. Re-running the endpoint after a successful removal is safe: the already-tombstoned entry validates and only the residue cleanup repeats.

## Identifier separation implementation status

The identity-separation implementation is on this dedicated follow-up PR and is separate from PR #145. Its additive D1 schema was applied to production D1 on 2026-10-28 after owner authorization. The production `d1_migrations` ledger entry is being verified separately; keep this PR unmerged until that verification is complete and the record PR is merged.

1. `notes.sync_uuid` is authoritative for Akatuki-owned notes. The additive `yaos_file_identity_map` table uniquely binds YAOS's stable `fileId`, D1 `sync_uuid`, and D1 note ID. Mapping conflicts fail closed; mapping writes are checked by reading them back.
2. Outbound sync uses D1 `notes.sync_uuid` first. A conflicting legacy frontmatter ID is rejected rather than silently adopted. Telegram identity behavior is unchanged and out of scope.
3. Incoming YAOS observations establish mappings for known D1 notes before classifying unmatched files. Creation requires a complete observation and no mapping/path/tombstone/pending-job/UUID conflict. Incomplete observations are `deferred`; complete but ambiguous observations are `needs_review`. Similar content does not merge notes.
4. Existing revision creation, per-note outbox ordering, tombstone/restore operations, expected-content conflict refusal, and YAOS read-back verification remain in place. The isolated integration test covers create, edit, rename, delete, restore, authenticated outbox diagnostics, and conflict refusal. `scripts/test-sync-outbox.mjs` covers dead-job retry, bounded listing without payload exposure, preservation of attempt/error evidence, and statement preparation for atomic mutation batches (snapshot payloads, pre-commit identity conflicts, and guarded job inserts).

Authenticated `GET /sync/identity-map?noteId=...` exposes one note's mapping for diagnostics. `GET /sync/identity-review?classification=deferred|needs_review&limit=...` lists bounded review cases without returning note bodies.

The separate existing-note migration is not included. When explicitly authorized in the future, it must run `restore-all → verify → organize` in that order. This PR does not modify YAOS source/protocol or write to production D1. Production deployment remains on hold until the ledger verification and migration-record PR are complete.

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
