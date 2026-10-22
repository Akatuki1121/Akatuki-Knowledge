# Agent memory policy

Agent memory is metadata over the existing Obsidian and Telegram notes. The note remains the sole copy of its text; metadata stores hashes for the normalized memory key and value, provenance, confidence, lifecycle state, and optional expiry. Retrieval continues to use the existing D1 text search. No Vectorize, R2, or external memory service is required.

## Classification and trust

| Kind | Intended use |
| --- | --- |
| `fact` | A durable fact explicitly stated by the user |
| `preference` | A durable user preference |
| `constraint` | A durable boundary or requirement |
| `decision` | An adopted or rejected decision and its rationale |
| `temporary_state` | A time-bound status, plan, or situation |
| `procedure` | A reusable, user-provided process |
| `hypothesis` | An inference that has not been confirmed |

Each entry has a canonical memory key, source note ID, source reference, record/update timestamps, confidence, trust level, and status. `user_stated` is reserved for content directly supported by the user's own words and confidence of at least 0.85. `user_confirmed` is reserved for an explicit user resolution of a conflict. Other captures are `inferred` and remain `unverified`; hypotheses are always unverified. Assistant-generated conclusions are not user knowledge.

Legacy `knowledge_type` remains populated for compatibility (`decision` maps to `rationale`, `procedure` to `procedure`, and other kinds to `fact`). Notes without metadata are labelled `legacy_unverified` in agent context.

## Lifecycle and conflicts

- `temporary_state` expires after 30 days by default. A supplied expiry is honored, capped at 365 days, and expired entries are provided only as historical context.
- A new active value for an existing memory key marks competing, unexpired values `conflicted`; it does not silently replace them.
- Responses must describe competing values and dates and ask the user rather than choosing one. Only an explicit user confirmation may supersede competing values.
- When note text changes outside a classified capture, existing metadata is marked `superseded`. The changed note remains searchable but is treated as legacy/unverified until classified again.
- Deleting a note writes suppression records for its content hash and each known memory key/value hash, and marks its metadata `forgotten`. Retrieval and automatic capture reject suppressed content or keys, including a rephrased value with the same key.
- A direct request not to remember or reuse a topic is never captured. Delete the relevant note to persist a suppression across future captures.
- An explicit restore removes that note's suppression records and returns forgotten entries as `unverified`; restoring a note does not silently re-confirm its contents.

## Safety and rollout

Credential-bearing captures are not given memory metadata. Existing note credential blocking and AI-permission checks remain in force. Memory metadata contains hashes rather than duplicated raw claims or keys; hashes are for matching, not anonymization guarantees.

The implementation uses D1 and the existing keyword search. Retrieval quality, conflict frequency, and expiry behavior should be measured before considering semantic/vector search or additional paid storage. Migration `0013_agent_memory_metadata.sql` is intentionally under `migrations/pending/`; the production deployment gate must remain in force until the migration has a separately reviewed rollout.
