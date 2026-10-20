# GitHub Actions / Workers Builds の運用手順

## CI の失敗・キャンセル

1. リポジトリの **Actions** から対象ブランチの最新runを開き、run ID・コミットSHA・失敗したjob/stepを確認する。
2. 同じブランチに新しいコミットがあり、古いrunが `cancelled` なら、古いrunを再実行せず最新runを確認する。CIは同じブランチの古い実行を自動キャンセルする。
3. `syntax-and-contract` が失敗した場合は、最初に失敗したstepのログを確認して修正する。修正なしの全体再実行を繰り返さない。
4. `yaos-worker-integration` が失敗した場合は、そのjobのログと失敗箇所を確認する。テストは分離したローカルD1とWorkerを使い、本番D1や本番Vaultを対象にしない。外部プロセスは3分で終了し、TERM後も停止しなければ5秒後に強制終了する。
5. 一時的なRunner/ネットワーク障害と判断できる場合だけ、GitHub Actionsの **Re-run failed jobs** を使う。コード・設定が原因なら先に修正コミットを作る。

## キャンセルが終わらない場合

- GitHub UIでrunとjobの状態を再確認する。状態が `completed`、`cancelled`、`queued` なら、実行中のrunとしてキャンセル要求を重ねない。
- `in_progress` のままなら、どのjob/stepが動いているか確認し、外部プロセスのtimeoutを待つ。
- timeoutを過ぎてもrunが実際に `in_progress` のまま残る場合に限り、適切な権限を持つ管理者がGitHubの強制キャンセル手段を使う。既にキャンセル処理中・終了済みのrunに再度キャンセルを重ねない。

## 本番デプロイとPreviewの区別

- `.github/workflows/deploy.yml` は `main` の対象ファイル更新または手動起動で本番Workerへの `wrangler deploy` を行う経路。手動起動も本番変更なので、検証目的では使わない。
- Cloudflare Workers Buildsでfeature branchに対して成功したPreview buildは、本番デプロイ成功の証拠ではない。build metadataのbranchとdeploy commandを確認する。
- 現時点ではGitHub Actionsの本番deploy workflowとCloudflare側のproduction build設定が唯一の経路に整理済みとは確認できていない。資格情報の追加、workflow削除、production build設定変更は、実行記録と設定を照合してから行う。
- pending migrationを参照するWorker変更は、migrationのレビュー・本番適用が済むまで本番デプロイしない。

## 変更後の確認

- PRの最新コミットSHAと、成功したCI runのSHAが一致することを確認する。
- Preview buildを実施した場合は、Cloudflareのbuild detailsでbranch、deploy command、build outcomeを確認する。
- 本番反映を許可された作業でも、デプロイ成功と実際のリクエスト動作は別々に確認する。
