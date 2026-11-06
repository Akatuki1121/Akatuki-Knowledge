# Notion → Akatuki Knowledge ノート移送部品 設計メモ

## 配置方針

**既存の `akatuki-knowledge` Worker には組み込まず、独立した Worker として分離する。**

- 既存 `src/index.js` は本番 Worker から復元した単一バンドルであり、元のソース構成が復元できていない。プロジェクトルールで推測による分割・改変が禁止されている。
- Notion と Akatuki の2つの強い権限を持つため、Notion トークンを既存 Worker に追加せず、権限・障害・ログの境界を分離できる。
- 専用 Cron を独立して停止・再実行でき、既存 Worker の Cron / D1 / Durable Object / YAOS binding / デプロイ経路を変更しない。
- この PR はソースと Wrangler 設定のみ。Cloudflare Worker の作成、secret 登録、Cron 有効化、本番デプロイは行わない。

## 処理フロー

1. Notion Data Source を照会し、`未処理` または `処理中` の行を1件選ぶ。
2. `Path` を検証する。絶対パス、空要素、`..`、隠しパス、Markdown 以外の拡張子は拒否する。
3. `GET /v1/pages/{page_id}/markdown` で本文を取得。切り詰め、未解決ブロック、Notion 専用構造、Notion 添付ファイル参照があれば fail-closed とし原本を残す。
4. 未処理行では Akatuki の同一パス取得 API を先に呼ぶ。既存なら `要確認` にして停止し、作成しない。未存在なら Notion の状態を `処理中` にしてから `POST /api/notes` を呼ぶ。
5. 作成後、Akatuki の同一パス取得、`GET /api/search` の完全一致、`GET /sync/outbox` の notes/upsert 行を確認する。outbox は pending / processing / sent を受け入れ、dead は成功と見なさない。
6. 3条件を満たした後だけ Notion ページを `PATCH /v1/pages/{id}` `{ "in_trash": true }` でゴミ箱へ移し、応答の `in_trash: true` も確認する。
7. `処理中` のまま中断した場合、次回は既存ノートを再確認して検索・outbox検証から再開する。Notion 側の削除失敗時も原本は残り、再検証できる。
8. パス重複や本文不一致は `要確認` とし、原本を保持する。一時的な API 失敗は `処理中` のまま次回再試行する。

## Notion データベース仕様

| プロパティ | 型 | 用途 |
| --- | --- | --- |
| Name | Title | ノートの表示タイトル |
| Path | Rich text | Obsidian の保管先。例: `Notes/Inbox/example.md` |
| 処理状態 | Select | `未処理` / `処理中` / `要確認` |

`処理状態` の初期値は `未処理`。中断後の回復と重複の識別に使う。Notion integration には Data Source と各ページへの Read / Update content capabilities を付与する。

## API と秘密情報

- Notion: `POST /v1/data_sources/{data_source_id}/query`、`GET /v1/pages/{page_id}/markdown`、`PATCH /v1/pages/{page_id}`
- Akatuki: Bearer 認証の `GET /api/notes/{path}`、`POST /api/notes`、`GET /api/search`、`GET /sync/outbox`
- Worker secrets: `NOTION_TOKEN`、`AKATUKI_API_TOKEN`
- Worker vars: `NOTION_DATA_SOURCE_ID`、`AKATUKI_API_URL`。プロパティ名は任意設定可能。
- トークン、本文、Notion API 応答本文はログに出さない。

## Notion の「削除」の実態

Notion API 2026-03-11 ではページを完全削除する API はない。ページ更新 `PATCH /v1/pages/{page_id}` に `in_trash: true` を指定し、ゴミ箱へ移動する。復元可能で、完全消去ではない。旧 API の `archived` は 2026-03-11 で `in_trash` に改名された。通常のゴミ箱移動はデータベースの通常ビューから消え、ゴミ箱から復元できる。Notion の Business / Enterprise 向け「Archive」機能（Archived バナーを付けて保管する機能）とは別概念である。

## Markdown 変換の範囲と制約

Notion の `GET /v1/pages/{page_id}/markdown` を使い、ブロック JSON の独自再構築はしない。標準的な見出し、段落、リスト、チェックリスト、引用、コード、テーブル、リンク等は Markdown として受け取れる。一方、Notion-flavored Markdown には callout、toggle、columns、database/page mention、synced block、meeting notes、埋め込み、ファイル等の独自タグがあり、Obsidian が同じ意味・レイアウトで表示できる保証はない。アップロード添付の参照も永続的な Obsidian 添付ファイル移送とは異なる。

初版は意味を黙って落とすより原本保持を優先する。Markdown API が truncated / unknown block を返す場合、Notion 専用構造ブロックや `notion-file-block://` 添付参照が含まれる場合は移送を中止する。外部 URL の Markdown リンクは保持する。ページのアイコン・カバー・コメント・データベースのプロパティ（Path 以外）・権限・ページ間の同期関係は本文へ移送しない。

## Cron 間隔と無料枠の負荷

初期値は **15分間隔（`*/15 * * * *`）**。1回につき1ページだけ処理し、96回/日。Workers Free の 100,000 requests/day と Cron Trigger 数上限に対して小さい。外部 API 待機時間は CPU time に含まれないが、Free の Cron CPU 上限は1回10msなので巨大な Markdown の解析や大量処理を避ける。Notion API は integration あたり平均約3 req/s の rate limit があるが、本 Worker は逐次処理で1回あたり数回の呼び出しに留める。429 / 5xx は原本を残して次回へ回す。滞留量が増えた場合は実測後に1回あたりの件数または間隔を見直す。

## 本番導入時に必要な作業（この PR の対象外）

1. 所有者が Notion Data Source を作成し、上記3プロパティを設定する。
2. Notion integration に Read / Update content capabilities を付ける。
3. Cloudflare で専用 Worker を作成し、Wrangler 設定を使ってデプロイする。
4. `NOTION_TOKEN` と `AKATUKI_API_TOKEN` を Worker secrets に登録し、Data Source ID と Akatuki API URL を vars に登録する。
5. Cron を有効化し、テスト用ノート1件で動作を確認する。

本 PR ではリソース作成・secret 登録・本番データ操作・デプロイを行わない。
