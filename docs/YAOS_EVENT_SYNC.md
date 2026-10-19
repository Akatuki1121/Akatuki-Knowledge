# YAOS event sync

## Goal

Keep the existing YAOS Worker and its Durable Object protocol unchanged. Akatuki Knowledge writes changes to a D1 outbox; the existing `YJS_CLIENT` Durable Object binding applies those changes to the YAOS Vault and verifies the result.

## Event path

1. A Telegram note is created or organized, or a note is corrected, deleted, or restored through the API.
2. Akatuki Knowledge records an immutable outbox event with the note snapshot.
3. A short background drain attempts immediate delivery after Telegram/API operations.
4. Failed events are retried with exponential backoff. After eight attempts they become `dead` for inspection; expired processing leases can be reclaimed.
5. The hourly scheduled run drains pending events before pulling changes from YAOS, preventing stale Vault content from overwriting queued Akatuki Knowledge edits. It then runs the existing Vault-to-D1 pull and scheduled maintenance.

## Identity and note paths

- Existing Obsidian notes continue to use their path as the D1 identity; the current YAOS reader recognizes the YAML `id:` frontmatter field.
- Telegram notes retain their stable D1 ID. Their Vault path is derived from the title plus a 16-character hash of that ID, so a title change updates the same Vault note instead of creating a duplicate.
- Telegram notes without an existing `id:` frontmatter field receive a deterministic UUID in that property when first written to the Vault.
- Deletions are represented as YAOS metadata tombstones. They are not implemented by removing CRDT records outright.
- Every successful delivery is followed by a read-back verification. A job is marked `sent` only after verification succeeds.

## Migration safety

The D1 outbox migration is intentionally stored under `migrations/pending/`, not the executable migrations directory. The original migration SQL for 0001-0007 is missing from the recovered repository. Do not deploy this Worker version until the outbox table has been applied to the live D1 database and the migration chain has been validated. This feature branch does not change production Worker code, D1 data, secrets, or YAOS.

## Scope and remaining checks

The outbox is wired to Telegram note creation/organization and the existing API correction, delete, and restore operations. Other mutation paths (including all automatic-organizer write branches and undo operations) still need an integration audit before claiming every note change is event-synchronized. The hourly Vault pull remains the repair path for YAOS-to-D1 changes; a full bidirectional conflict policy still needs staging validation.
