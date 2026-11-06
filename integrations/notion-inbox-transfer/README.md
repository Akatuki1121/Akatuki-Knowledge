# Akatuki Notion Inbox Transfer

Notion database inbox → Akatuki Knowledge の一方向ノート移送 Worker。

## 必須設定

Cloudflare Secrets Store:
- Store ID: `c7c404d57b1541349d9456c72a55af00`
- Secret: `NOTION_TOKEN`
- Secret: `AKATUKI_API_TOKEN`
- どちらも Permission scope は `Workers` にする。
- Worker は Wrangler の Secrets Store binding 経由で参照し、トークン値を Worker の secret_text として個別登録しない。

既存ストアにシークレットがまだない場合は、Wrangler の対話プロンプトで値を入力して登録する（値をコマンド引数に含めない）。

```sh
npx wrangler secrets-store secret create c7c404d57b1541349d9456c72a55af00 --name NOTION_TOKEN --scopes workers --remote
npx wrangler secrets-store secret create c7c404d57b1541349d9456c72a55af00 --name AKATUKI_API_TOKEN --scopes workers --remote
```

Worker の binding は `wrangler.toml` に定義済み。実行時に各 binding の `get()` で値を取得する。

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

Deploying this Worker, creating its Cloudflare resource, registering Secrets Store values, and enabling Cron are owner-only post-approval steps.
