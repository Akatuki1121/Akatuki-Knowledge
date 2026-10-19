# Durable Object migration evidence

Captured read-only from Cloudflare Worker version metadata on 2026-10-19. This records what the API exposed; it is not, by itself, a reconstruction of the original Wrangler migration declarations.

## Observed version sequence

| Worker version | Created (UTC) | Migration tag | `YjsClientDO` handler | `YJS_CLIENT` binding namespace |
|---:|---|---|---|---|
| 25 | 2026-10-18 13:44:16Z | Not present | No | Not present |
| 26 | 2026-10-18 13:56:09Z | v1 | Yes | `6b65be78eaf74ec5ae1e7efac257ec33` |
| 27 | 2026-10-18 14:14:39Z | v1 | Yes | `6b65be78eaf74ec5ae1e7efac257ec33` |
| 28 | 2026-10-18 14:16:03Z | v1 | Yes | `6b65be78eaf74ec5ae1e7efac257ec33` |
| 29 | 2026-10-18 14:28:11Z | v1 | Yes | `6b65be78eaf74ec5ae1e7efac257ec33` |
| 30 | 2026-10-18 14:32:59Z | v2 | Yes | Binding not present in this version's metadata |
| 31 | 2026-10-18 14:33:19Z | v3 | Yes | `b2142bd7cede420699323218e7112c56` |
| 32 | 2026-10-18 14:37:37Z | v3 | Yes | `b2142bd7cede420699323218e7112c56` |
| 33 | 2026-10-18 14:48:01Z | v4 | Yes | Binding not present in this version's metadata |
| 34 | 2026-10-18 14:48:24Z | v5 | Yes | `e84bbcb28ff0482a9b7b9a1cce2e28e5` |
| 35 | 2026-10-18 15:27:45Z | v5 | Yes | `e84bbcb28ff0482a9b7b9a1cce2e28e5` |

The latest observed deployed version is 51 with migration tag `v5` and namespace `e84bbcb28ff0482a9b7b9a1cce2e28e5`.

## Recovered local declaration

After the original read-only capture, a local `wrangler.toml` was found containing this ordered migration sequence:

| Tag | Declaration |
|---|---|
| `v1` | `new_sqlite_classes = ["YjsClientDO"]` |
| `v2` | `deleted_classes = ["YjsClientDO"]` |
| `v3` | `new_sqlite_classes = ["YjsClientDO"]` |
| `v4` | `deleted_classes = ["YjsClientDO"]` |
| `v5` | `new_sqlite_classes = ["YjsClientDO"]` |

The current recovery branch preserves these declarations in order. The local file is the source for the operation details; Cloudflare version metadata independently corroborates the tag progression and changing namespace IDs, but does not expose the original migration arrays.

## Data-loss implication

Cloudflare's legacy Durable Object migration documentation states that a `deleted_classes` migration deletes all Durable Objects for that class, including stored data. Therefore, if the recovered declarations reflect the operations actually applied, `v2` and `v4` were destructive lifecycle transitions; the namespace IDs observed for `v1`, `v3`, and `v5` are consistent with recreation. Do not assume data from an earlier namespace survived those transitions. This metadata does not establish whether the deleted namespaces held important data.

The live Worker currently binds to the `v5` namespace `e84bbcb28ff0482a9b7b9a1cce2e28e5`. Because the live migration tag is already `v5`, the recovered history is intended to preserve the deployed migration ledger, not to introduce new lifecycle operations. However, the successful Wrangler `--dry-run` is local validation only and does not verify remote migration reconciliation or prove a production deployment safe.

## Recovery decision

- Preserve the ordered `v1`–`v5` declarations; do not reorder, collapse, or invent additional migrations.
- Do not deploy to production as part of this recovery verification.
- Before any production deployment, independently establish the remote migration reconciliation behavior and review the deployed bundle/configuration. No Durable Object instances were queried or changed during this investigation.
