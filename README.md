# Akatuki-Knowledge

Obsidian のノートを検索し、AI で整理するための個人用ナレッジサービスです。Cloudflare Workers と D1 の上で動き、HTTP API から操作できます。Telegram ボットは廃止しました。

## できること

- **ノート同期**: Obsidian Vault と D1 のノートを、YAOS 経由のイベント同期でそろえます。定期実行の照合は、取りこぼしを直す安全網です。同期 outbox の dead 履歴は、認証済み `POST /sync/outbox/purge-dead` で dry-run 確認後に削除できます。 YAOS conflict コピーの除去は、凍結ターゲットと本文同一性を検証する `POST /sync/remove-vault-fossil` で限定的に扱います。
- **ノート作成 API**: `POST /api/notes`（Bearer 認証）で指定パスに新規ノートを作成します。既存パスは上書きせず `409` を返し、作成と同期 outbox 登録を同一 D1 batch で行います。YAOS の実ファイル ID は最初の upsert 応答から保存し、Akatuki 側で捏造しません。認証情報を検出した本文は保存できますが、AI 送信を禁止します。
- **バックグラウンドタスク**: `POST /api/agent-tasks` で、ナレッジベースを検索して要約するタスクを非同期に実行します。結果は `GET /api/agent-tasks` で取得します。ノートの作成・追記・移動・削除は行いません。仕様は [`docs/BACKGROUND_TASKS.md`](docs/BACKGROUND_TASKS.md) を参照してください。
- **長期記憶メタデータ**: 既存ノートに由来・信頼度・有効期限などのメタデータを付けて扱います。D1 マイグレーション `0013_agent_memory_metadata.sql` は 2026-10-22 に本番へ適用・台帳記録済みで、`migrations/` に配置されています。

## 安全面の方針

- AI へ送る内容は送信前に検査します。認証情報が見つかった場合や、安全にマスキングできない機微情報を含む場合は送信を止めます。パターンベースの検出なので、すべての秘密情報の検出は保証しません。
- AI へ送れるのは `ai_allowed` で許可されたノートだけです。
- ノートを変更する操作は、ユーザーの明示的な承認を経て実行します。

## 構成

| コンポーネント | 役割 |
| --- | --- |
| Cloudflare Workers(`src/index.js`) | API とノート同期 |
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
| [`docs/AI_SEND_POLICY.md`](docs/AI_SEND_POLICY.md) | AI 送信の許可・機微情報の扱い(Issue #61) |
| [`docs/YAOS_EVENT_SYNC.md`](docs/YAOS_EVENT_SYNC.md) | YAOS イベント同期 |
| [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md) | 本番環境の観測記録 |
| [`migrations/README.md`](migrations/README.md) | D1 マイグレーションの扱いと復旧の経緯 |
| [`docs/CLOUDFLARE_RECOVERY.md`](docs/CLOUDFLARE_RECOVERY.md) | Cloudflare からの復旧記録 |

仕様の議論、進捗、未解決事項は [Issues](https://github.com/Akatuki1121/Akatuki-Knowledge/issues) と [Pull Requests](https://github.com/Akatuki1121/Akatuki-Knowledge/pulls) で管理します。
