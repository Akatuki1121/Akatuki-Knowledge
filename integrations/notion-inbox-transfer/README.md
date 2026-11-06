# Akatuki Notion Inbox Transfer

Notion database inbox → Akatuki Knowledge の一方向ノート移送 Worker。

## 必須設定

Worker secrets:
- `NOTION_TOKEN`
- `AKATUKI_API_TOKEN`

Worker vars:
- `NOTION_DATA_SOURCE_ID`
- `AKATUKI_API_URL`

任意 vars:
- `NOTION_PATH_PROPERTY` (default: `Path`)
- `NOTION_TITLE_PROPERTY` (default: `Name`)
- `NOTION_STATUS_PROPERTY` (default: `処理状態`)

Notion database properties:
- `Name`: Title
- `Path`: Rich text
- `処理状態`: Select with `未処理`, `処理中`, `要確認`; default `未処理`

The Notion integration needs read and update content capabilities. Never commit credentials or put them in Wrangler vars.

Cron runs every 15 minutes and processes at most one pending/recoverable row per invocation. Notes are written only through authenticated `POST /api/notes`. Before moving a Notion page to trash, the Worker verifies the exact Akatuki path read, exact search hit, and matching live upsert outbox event.

Deploying this Worker, creating its Cloudflare resource, registering secrets, and enabling Cron are owner-only post-approval steps.
