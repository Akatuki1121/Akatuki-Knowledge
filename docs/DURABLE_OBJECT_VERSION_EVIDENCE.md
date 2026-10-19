# Durable Object migration evidence

Captured read-only from Cloudflare Worker version metadata on 2026-10-19. This records what the API exposed; it is not a reconstruction of the original Wrangler migration declarations.

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

The latest observed deployed version is 49 with migration tag `v5` and namespace `e84bbcb28ff0482a9b7b9a1cce2e28e5`.

## What this establishes

- Cloudflare retains version metadata showing the tag progression `v1` → `v2` → `v3` → `v4` → `v5`.
- The namespace recorded for `YJS_CLIENT` differs across the observed v1, v3, and v5 versions.
- Versions 30 and 33 expose the migration tags v2 and v4 but do not expose a `YJS_CLIENT` binding in their version metadata.
- Version metadata does **not** expose the ordered `new_classes`, `renamed_classes`, `deleted_classes`, or `new_sqlite_classes` declarations needed to faithfully recreate the original migration configuration.

## Recovery decision

Do not infer missing migration declarations from namespace changes alone. Keep the original v1–v5 declarations marked unrecovered until source history, Wrangler config, or an authoritative deployment artifact is found. Do not deploy a guessed migration chain to production. This investigation used read-only Worker version endpoints; it did not query or modify Durable Object instances.
