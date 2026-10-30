# Cloudflare予算管理・自己監査ロードマップ

最終更新: 2026-10-30  
対象: Akatuki Knowledge Worker / D1 / Durable Objects / Workflows / Workers AI / YAOS  
前提: Akatuki Knowledge と YAOS は同じ Cloudflare アカウントの無料枠を共有する。

## 1. 現在の方針

Workers AIのアプリ側Neurons上限・タスク別呼び出し回数・タスク別token上限は設けない。Cloudflare Freeのアカウント共有10,000 Neurons/日を唯一の利用上限とし、実際の超過拒否はCloudflareに任せる。アプリ側のusage台帳は計測・監査専用であり、テーブルが未作成でもAI呼び出しを止めない。

- モデル: @cf/zai-org/glm-4.7-flash
- モデルcontext window: 131,072 tokens
- 出力: max_completion_tokensを使用し、入力推定分を差し引いたcontext残量まで要求する
- 旧8,000 Neurons/日、通常20/改善5回のAI呼び出し制限、通常40,000/改善12,000 token制限、1回1,024 output token制限は撤去
- AI呼び出し回数・token・Neuronsの台帳はbest-effort telemetry。CloudflareのFree枠を予約・拒否する独自ゲートにはしない
- Cloudflareが日次Neurons枠の超過を返した場合は workers_ai_daily_quota_exhausted と分類し、UTC 00:01まで待機。これは通常の失敗試行を消費せず、タスク期限を次回実行可能時刻+1時間へ延長し、リセット後に自動再開する

モデル仕様: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/

Workers AI以外の資源制約は別管理とする。WorkflowsはFree枠3,000 steps/日に対して、32 steps/タスク、2,700 reserved steps/日のアプリ内予約を維持する。これはAI使用量の制限ではなく、Workflowsという別資源の保護である。実消費step数による精算は今後の改善対象。

## 2. Cloudflare Free枠

2026-10-30に公式Docsで再確認した値。日次枠は該当サービスのUTC日次リセットに従う。

| サービス | Free枠 |
|---|---:|
| Workers | 100,000 requests/日（Workflows executionsと共有） |
| D1 | 5,000,000 rows read/日、100,000 rows written/日 |
| Durable Objects | 100,000 requests/日、13,000 GB-s/日 |
| Workers AI | 10,000 Neurons/日 |
| Workflows | 100,000 executions/日（Workersと共有）、3,000 steps/日 |

参照:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

## 3. GraphQL Analyticsの観測（2026-10-23〜2026-10-29）

2026-10-30に接続済みCloudflareアカウントのGraphQL Analyticsを読み取り、7日分を集計した。Workers・D1・DOはアカウント全体、WorkflowsはAkatuki KnowledgeのWorkflow名で絞り込んだ。D1はアカウント内の全データベース、DOはAkatuki KnowledgeとYAOSを含む。

| UTC日付 | Workers requests | D1 rows read / written | DO requests | Workflow starts | Workers AI Neurons |
|---|---:|---:|---:|---:|---:|
| 10/23 | 135 | 103,495 / 1,389 | 616 | 5 | 0 |
| 10/24 | 190 | 145,904 / 1,572 | 672 | 13 | 0 |
| 10/25 | 444 | 373,551 / 9,300 | 1,986 | 7 | 1,276.25 |
| 10/26 | 141 | 16,870 / 12 | 246 | 0 | 0 |
| 10/27 | 251 | 27,991 / 1,002 | 739 | 0 | 0 |
| 10/28 | 1,207 | 1,020,033 / 8,172 | 4,015 | 0 | 0 |
| 10/29 | 838 | 275,241 / 5,513 | 3,733 | 2 | 0* |

Workflow startsはWORKFLOW_STARTの件数。step数は状態別イベントが同じ実行を重複して表すため、この表では合算していない。DO requestsはakatuki-knowledgeとyaosの合計。Workers・D1・DOのアカウント内他サービスの利用も含む。

観測期間中の最大値を無料枠と比較すると、Workers requestsは1,207/100,000（約1.2%）、D1 rows readは1,020,033/5,000,000（約20.4%）、D1 rows writtenは9,300/100,000（約9.3%）、DO requestsは4,015/100,000（約4.0%）、Workflow startsは13/100,000（約0.013%）。この期間ではWorkers/D1/DO/Workflowのアカウント全体使用量は無料枠に対して余裕があった。D1 readが相対的に最も高く、将来も無視してよいとは言えない。

Workers AIは10/25に451件・1,276.25 Neurons（入力75,606 tokens、出力8,976 tokens）が観測された。モデルは @cf/meta/llama-3.1-8b-instruct-fp8。10/29は6件、モデル @cf/meta/llama-3.1-8b-instruct、errorCode 5028、Neurons 0。いずれもGraphQLのrequestSourceはunknown、tagは空で、Akatuki Knowledge由来かを特定できなかった。したがってこの数値をAkatukiのAI実績として扱わず、アカウント全体の観測値として記録する。10/29の6件は失敗応答の可能性があるが、Neurons 0だけで消費ゼロとは断定しない。

DOのGraphQL wallTimeはDO durationのGB-sと同じ指標ではないため、13,000 GB-s/日の利用率はこの調査では算出していない。Workers AI Neuronsもモデル・呼び出し元の帰属ができず、タスク単位の実績分布は確定できなかった。

## 4. 実装済みの自己監査・自己改善

### 毎日の監査

Worker Cron 55 23 * * *（UTC）で runBudgetSelfAudit を実行する。監査は次の2層。

1. 決定的な運用監査: 直近24時間のタスク状態、繰り返しエラー、失敗率、当日Workflow予約steps、Workers AI usage telemetryを集計する。繰り返しエラー3件以上、失敗率30%以上（5件以上）、Workflow予約2,700の80%以上、Workers AI 10,000 Neuronsの80%以上を警告として記録する。これらは警告閾値であり、Workers AIの停止ゲートではない。
2. リポジトリ監査: 毎日 Notes/改善/自己監査-YYYY-MM-DD.md を作成し、origin: budget-audit と audit_generated: true を付与する。既存の改善エージェントがリポジトリ全体、Workflow、D1 migrations、Cloudflare枠、失敗回復、CI、自動マージを調べる。改善が必要なら実装・テスト・migration・docsをまとめたPRを作成し、根拠がなければ空PRを作らず結果を記録する。

監査レポートはapp_metaにUTC日付単位で保存し、認証済みGET /api/budget-auditから最新14件を取得できる。監査ノートは通常のYAOS同期・改善Inbox経路に流す。監査タスク自身が監査を再起動する経路は設けない。

### 改善エージェントの変更範囲

- 変更可能: src/、scripts/、tests/、docs/、schema-snapshots/、migrations/pending/、wrangler.toml、package.json、package-lock.json、README.md
- 新規の読み取り専用GitHub Actions workflowは作成可能。ただしpull_request_target、workflow_run、secrets、write権限を含む新規workflowは禁止。
- 保護対象: .github/workflows/auto-merge.yml、.github/workflows/check.yml、.github/workflows/deploy.yml。これらは自動改善エージェントが変更できない。
- 適用済みmigration履歴への直接変更、削除、release、deploy、権限変更は不可。新しいDB変更はmigrations/pending/に置き、別途オーナー承認と本番適用が必要。
- 既存ファイルはGitHub blob SHAを前提にunified diff apply_patchで編集できる。巨大なsrc/index.jsを全量再生成せずに必要な箇所だけ修正できる。
- 1回の計画は最大50操作、ファイル本文20万文字、差分10万文字まで。モデル呼び出し回数・ツール呼び出し回数のアプリ独自上限は設けない。モデルcontext、Workflow step、GitHub API、D1など実サービスの制約は適用される。

### 自動マージ

.github/workflows/auto-merge.ymlはPurgeのpull_request_target方式を採用する。

- PR作成者とイベント実行者がともにAkatuki1121の非Draft PRはgh pr merge --auto --squashを有効化する。
- Dependabotはメタデータを確認し、既知のpatch/minor/major更新のみ自動マージを有効化する。
- 自己改善エージェントのPRはexecutor側でもGraphQLのsquash auto-mergeを要求する。
- AIの自己判定はマージ条件にしない。GitHubの必須CIとBranch Protectionが最終ゲートであり、失敗・競合・必須チェック不足ならマージされない。

## 5. 本番D1スキーマとmigrationゲート（2026-10-30確認）

PR #174のマージ後、GitHub Actionsの本番Deploy workflow（run 41015689299）は成功し、Workerコードはmain commit cd4a9f5で本番デプロイ済み。一方、本番D1のmigration ledgerは0015_yaos_file_identity_map.sql（id 15）で止まっていた。

- agent_task_daily_budgetの本番CHECK制約はtasks_reserved BETWEEN 0 AND 60 / workflow_steps_reserved BETWEEN 0 AND 2000。
- workers_ai_daily_usageテーブルは存在しない。
- 以前はAI予約テーブル不在でAI呼び出しが止まる実装だったが、この実装ブランチでusage台帳をbest-effort telemetryへ変更したため、テーブル不在だけではWorkers AIを停止しない。
- 一方、Workflow日次予約は2,700 stepsを利用するコードであり、本番D1の2,000 steps CHECK制約とは不一致のまま。migration 0017適用までは、2,000を超える予約がD1制約で失敗し得る。

migrations/pending/0016〜0018はusage台帳・Free Workflow予算・失敗計測用。Deploy workflowはpending migrationが残る間は自動デプロイを停止する。本番D1への適用・Worker再デプロイはこの実装ブランチでは行わない。オーナー承認のある別作業で0016→0017→0018を適用し、ledgerとschemaを照合する必要がある。

## 6. 残作業

| 作業 | 状態・前提 |
|---|---|
| Workers AIの独自Neurons/呼び出し/token上限撤去 | この実装ブランチで対応 |
| 日次quota到達後のUTCリセット待ち・自動再開 | この実装ブランチで対応 |
| 定期自己監査・改善ノート起票・既存改善エージェント接続 | この実装ブランチで対応 |
| Purge方式のsquash auto-merge | この実装ブランチで対応 |
| 本番D1 migrations 0016〜0018適用とschema照合 | オーナー承認・別作業。未実施 |
| GraphQL Analytics用read-only Account tokenをWorkerへ接続 | オーナーがtokenを発行・設定する必要あり |
| Workflow実消費stepの精算、D1/DO/YAOSのアカウント共有量照合 | 別段階。現在は予約と監査値の一部のみ |
| 実運用でのquota error message/HTTP codeの確認 | Workers AI日次枠を使い切るかCloudflare側の応答仕様を確認する必要あり |
