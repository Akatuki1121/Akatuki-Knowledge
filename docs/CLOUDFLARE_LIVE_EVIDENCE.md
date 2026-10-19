# Cloudflare-first recovery evidence

Captured read-only from Cloudflare APIs on 2026-10-19. This is an evidence record, not a deployment configuration to apply blindly.

## `akatuki-knowledge` Worker

- Current deployed version: version 49, ID `9f46f976-9f9e-4a7b-831b-f5e6d668b651`.
- Deployment ID: `9fb82e9a-c350-4ef4-8efe-9a44fa58c4ff`, created `2026-10-18T17:58:28.075243Z` (2026-10-19 02:58:28 JST).
- Current settings: compatibility date `2026-10-17`, standard usage model.
- Live bindings observed: D1 `DB` → `e8c57dbe-0175-43d8-9c16-0501e0c1d5a6`; service binding `YAOS` → `yaos` production; Durable Object binding `YJS_CLIENT` → class `YjsClientDO`, namespace `e84bbcb28ff0482a9b7b9a1cce2e28e5`; text/secret bindings are recorded by name only, never by secret value.
- The current script-content endpoint returns the deployed bundle. The bundle's `wrapper.js` code matches `main/src/index.js` apart from the trailing newline observed in the earlier comparison. The bundle is authoritative for the deployed behavior, but it is bundled output rather than the original project/build inputs.
- Cloudflare deployment history lists versions from 2026-10-17 onward, with upload/deployment trigger annotations. Version metadata exposes tags and bindings, but not the complete original Wrangler migration operation arrays.

## `yaos` Worker

- Current settings were retrieved read-only. Compatibility date: `2026-03-02`.
- Durable Object bindings: `YAOS_CONFIG` → class `ServerConfig`, namespace `bbb1227af8314a5393cdbfa9d0aefb69`; `YAOS_SYNC` → class `VaultSyncServer`, namespace `08a506977fec4448ad89d208fe236dc5`.
- Cloudflare lists one version/deployment, created `2026-10-18T11:30:51.702769Z` (2026-10-18 20:30:51 JST), version ID `18ae722f-ae97-40f9-bec4-7d127ae5477b`.
- The current deployed bundle contains the server-side code, including SQLite schema initialization for its own Durable Objects. It does not, by itself, reveal the original Wrangler migration declarations used to create/migrate those namespaces.

## D1

- Cloudflare database `Akatuki-knowledge`, ID `e8c57dbe-0175-43d8-9c16-0501e0c1d5a6`, created `2026-10-17T11:59:42.464Z`, currently reports 18 tables.
- The D1 schema snapshot and `d1_migrations` ledger in the recovery branch are derived from the live database. The ledger records which migration names ran, not the missing original SQL file contents.
- D1 exposes query/export and Time Travel APIs. Do not use a restore, import, or mutating query as part of this recovery without a separate explicit decision. The read-only bookmark endpoint returned a bookmark during this inspection; it was not used to restore anything.

## Recovery rule

Prefer Cloudflare's live configuration, current deployed bundle, D1 schema/data, and retained version/deployment metadata over assumptions from repository branches. Treat repository code as recovered source only after comparing it to those artifacts. Where Cloudflare itself does not retain the needed historical artifact (such as original migration arrays or SQL source files), mark that part unrecovered and reconstruct it separately. No production code, database, or Durable Object instances were modified by this evidence collection.
