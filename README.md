# Akatuki-Knowledge

Obsidian のノートを検索し、AI で整理するための個人用ナレッジサービスです。Cloudflare Workers と D1 の上で動き、HTTP API から操作できます。Telegram ボットは廃止しました。

## できること

- **ノート同期**: Obsidian Vault と D1 のノートを、YAOS 経由のイベント同期でそろえます。定期実行の照合は、取りこぼしを直す安全網です。同期 outbox の dead 履歴は、認証済み `POST /sync/outbox/purge-dead` で dry-run 確認後に削除できます。 YAOS conflict コピーの除去は、凍結ターゲットと本文同一性を検証する `POST /sync/remove-vault-fossil` で限定的に扱います。
- **ノート作成 API**: `POST /api/notes`（Bearer 認証）で指定パスに新規ノートを作成します。既存パスは上書きせず `409` を返し、作成と同期 outbox 登録を同一 D1 batch で行います。YAOS の実ファイル ID は最初の upsert 応答から保存し、Akatuki 側で捏造しません。認証情報を検出した本文は保存できますが、AI 送信を禁止します。
- **同一性を保ったノート移動 API**: `POST /api/notes/<URLエンコードした現在のパス>/move`（Bearer 認証）で `newPath` を指定します。`notes.id`、`sync_uuid`、本文、contentHash、リビジョンは維持し、`notes.path`・同一性マップの `last_path`・同期 outbox を同一 D1 batch で更新します。移動先のノートや別 fileId の同一性マップが存在する場合は拒否します。必要に応じて `expectedContentHash` で楽観的ロックを指定できます。マッピングがまだ無い作った直後のノートは、`fileId`（`GET /sync/diff` の観測から得た Vault の fileId）を併せて渡すことで、pull なしでマッピング確立と移動を同時に行えます。
- **現在のパスによるノート API**: `GET /api/notes/<URLエンコードしたパス>` で生存ノートの本文とメタデータを取得できます。`DELETE /api/notes/<引数>` は現在の `notes.path` を優先し、該当しなければ従来の `notes.id` / Telegram ID として解決します。パス参照と ID 参照が異なるノートを指す場合は `409 ambiguous_note_reference` で拒否します。
- **全件マニフェスト**: `GET /api/sync/manifest?limit=500&cursor=...` は `nextCursor` を使ってページ送りでき、`totalCount` に全レコード件数を返します。既存の `notes` / `nextCursor` フィールドは維持されます。
- **バックグラウンドタスク**: `POST /api/agent-tasks` で、ナレッジベースを検索して要約するタスクを非同期に実行します。結果は `GET /api/agent-tasks` で取得します。ノートの作成・追記・移動・削除は行いません。仕様は [`docs/BACKGROUND_TASKS.md`](docs/BACKGROUND_TASKS.md) を参照してください。
- **改善依頼の自動実行**: 毎時の Vault pull が成功した後、`Notes/改善/`（`このフォルダについて.md` を除く）の D1 ノートを走査します。`sync_uuid` と `content_hash` の組み合わせで重複起票を防ぎ、Workers AI で変更計画を作成します。変更対象は `src/`・`scripts/`・`tests/`・`docs/`・`schema-snapshots/`、`migrations/pending/`、許可されたルート設定、権限制限付きの新規 GitHub Actions workflow まで拡張しています。保護対象の `auto-merge.yml`・`check.yml`・`deploy.yml` は変更できません。計画ハッシュを再検証してから実行し、実装・テスト・migration・ドキュメントをまとめてPRにします。Purge方式の `gh pr merge --auto --squash` と同じく、GitHubの必須チェックが成功するまで自動マージを待機します。
- **Workers AIの利用枠**: アプリ独自のNeurons・model call数・task token数の上限は設けず、Cloudflare Freeのアカウント全体10,000 Neurons/UTC日のみを利用枠とします。利用台帳は計測専用で、Cloudflareがquota超過を返したタスクは次のUTC日次リセット後に自動再開します。出力長はモデルのコンテキスト上限に従います。Workflowsは別資源として32 steps/タスク・2,700 reserved steps/UTC日の受付ゲートを維持します。
- **定期自己監査**: UTC 23:55にD1のタスク状態・失敗分類・Workflow予約・Workers AI telemetryを監査し、必要な改善ノートを `Notes/改善/` に起票します。通常の改善エージェントがコード・テスト・CI・migration・設定を確認し、必要な修正をPRにまとめます。自己監査の再帰起動はしません。Web調査は背景タスク経路では無効です。
- **長期記憶メタデータ**: 既存ノートに由来・信頼度・有効期限などのメタデータを付けて扱います。D1 マイグレーション `0013_agent_memory_metadata.sql` は 2026-10-22 に本番へ適用・台帳記録済みで、`migrations/` に配置されています。

## 安全面の方針

- AI へ送る内容は送信前に検査します。認証情報が見つかった場合や、安全にマスキングできない機微情報を含む場合は送信を止めます。パターンベースの検出なので、すべての秘密情報の検出は保証しません。
- AI へ送れるのは `ai_allowed` で許可されたノートだけです。
- 通常のノート変更 API は既存の認証・outbox 経路を使います。改善エージェントの GitHub 書き込みは、明示的な許可範囲と計画ハッシュを満たす場合に限り自動実行します。

## 構成

| コンポーネント | 役割 |
| --- | --- |
| Cloudflare Workers(`src/index.js`) | API、ノート同期、Workers AI による制約付き改善エージェント |
| Cloudflare D1(`Akatuki-knowledge`) | ノート、同期状態、タスク状態の永続化 |
| Durable Objects / Yjs | ノート同期のリアルタイム状態 |
| Cloudflare Workflows | バックグラウンドタスクの実行 |
| YAOS | ノートの同期先(別 Worker。プロトコルは変更しません) |
| GitHub Actions | 検査、および条件を満たした場合の本番デプロイ |

`src/index.js` は、稼働中の Worker から復元した 1 ファイルのバンドルです。元のソースマップが無いため、推測でモジュール分割はしていません。詳細は [`src/README.md`](src/README.md) を参照してください。

## 開発

必要なもの: Node.js 22、Python 3(一部の検査に使います)。

```sh
npm ci
npm run check        # 全検査を並列実行
npm run check:sync   # 同期・バックグラウンドタスク関連のみ
```

`npm run check` は、構文、同期契約、同期 ID と競合処理、ノート ID の安全な復旧、バックグラウンドタスクの再試行ポリシーとスキーマ、Wrangler 設定を検証します。保留中のマイグレーションの適用や、本番リクエストの動作検証は行いません。

## デプロイとマイグレーション

- `main` へのマージは本番デプロイの経路を動かしうるため、変更は Pull Request 経由で行います。
- `migrations/pending/` に SQL がある間、GitHub Actions の本番デプロイは自動で止まります。`0013_agent_memory_metadata.sql` は 2026-10-22 に本番 D1 へ適用し、台帳へ記録したうえで `migrations/` へ移動済みです。
- `migrations/0008`〜`0013` は、本番 D1 の台帳に記録済みであり、リポジトリ側のマイグレーション履歴にも反映済みです。`0008` は再構築版であり、歴史的な原本ではありません。
- 既存の本番 D1 に対して、`bootstrap/` の SQL や `schema-snapshots/` を実行してはいけません。
- 本番の観測記録と復旧上の制約は [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md) を参照してください。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | AI エージェント向けの作業ルール |
| [`docs/AGENT_MEMORY.md`](docs/AGENT_MEMORY.md) | 長期記憶の分類、信頼度、競合、失効ポリシー |
| [`docs/BACKGROUND_TASKS.md`](docs/BACKGROUND_TASKS.md) | バックグラウンドタスクの設計と制限 |
| [`docs/BACKGROUND_TASK_BUDGET_ROADMAP.md`](docs/BACKGROUND_TASK_BUDGET_ROADMAP.md) | Cloudflare予算再設計の調査結果・段階移行・自己監査計画 |
| [`docs/AI_SEND_POLICY.md`](docs/AI_SEND_POLICY.md) | AI 送信の許可・機微情報の扱い(Issue #61) |
| [`docs/YAOS_EVENT_SYNC.md`](docs/YAOS_EVENT_SYNC.md) | YAOS イベント同期 |
| [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md) | 本番環境の観測記録 |
| [`migrations/README.md`](migrations/README.md) | D1 マイグレーションの扱いと復旧の経緯 |
| [`docs/CLOUDFLARE_RECOVERY.md`](docs/CLOUDFLARE_RECOVERY.md) | Cloudflare からの復旧記録 |

仕様の議論、進捗、未解決事項は [Issues](https://github.com/Akatuki1121/Akatuki-Knowledge/issues) と [Pull Requests](https://github.com/Akatuki1121/Akatuki-Knowledge/pulls) で管理します。
