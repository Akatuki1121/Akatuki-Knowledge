# Cloudflare予算管理・自己監査ロードマップ

確認日: 2026-10-30  
対象: Akatuki-Knowledge Worker / D1 / Durable Objects / Workflows と YAOS  
前提: Akatuki-KnowledgeとYAOSは同じCloudflareアカウントのFree quotaを共有する。

## 現在の結論

Workers AIについて、Cloudflare FreeのNeurons枠を超えるアプリ独自の停止条件は撤去した。Cloudflareアカウント全体の10,000 Neurons/UTC日が唯一の利用枠であり、Workers AI利用台帳は観測専用である。タスク単位のmodel call数・token数上限、改善タスク固有のAI呼び出し数上限、1回1,024 output token制限も撤去し、GLM-4.7-Flashのコンテキスト上限に合わせた。

CloudflareがWorkers AIのquota exhaustionを返した場合、タスクをwaitingにし、次のUTC 00:00以降にWorkflow recoveryで再開する。Neurons台帳が未作成・未適用・書き込み失敗でもAI呼び出しを止めない。Cloudflareの実際のquotaを超えて無料利用できるわけではなく、課金を有効にする変更でもない。

Workers AI以外のCloudflare資源は別枠で管理する。特にWorkflowsはFreeの3,000 steps/dayに対し、1タスク32 steps・日次2,700 reserved stepsの受付ゲートを維持する。これはAI利用上限ではなく、他のCloudflare workload用に300 stepsを残す設計。実消費量の精算とCloudflare全体利用量の帰属は今後の改善余地として残す。

## 1. 以前の調査結果と注意点

2026-10-23〜2026-10-29のGraphQL Analyticsを2026-10-30に取得した。Workers・D1・DOはアカウント全体、WorkflowsはAkatuki-KnowledgeのWorkflow名で集計した。D1はアカウント内全データベース、DOはAkatuki-KnowledgeとYAOSを含む。

| UTC日付 | Workers requests | D1 rows read / written | DO requests | Workflow starts | Workers AI Neurons |
|---|---:|---:|---:|---:|---:|
| 10/23 | 135 | 103,495 / 1,389 | 616 | 5 | 0 |
| 10/24 | 190 | 145,904 / 1,572 | 672 | 13 | 0 |
| 10/25 | 444 | 373,551 / 9,300 | 1,986 | 7 | 1,276.25 |
| 10/26 | 141 | 16,870 / 12 | 246 | 0 | 0 |
| 10/27 | 251 | 27,991 / 1,002 | 1,148 | 0 | 0 |
| 10/28 | 284 | 34,112 / 1,338 | 1,406 | 0 | 0 |
| 10/29 | 303 | 43,800 / 1,501 | 1,941 | 0 | 0 |

この観測では、D1 readが最大でも1.02M/5M（20.4%）、D1 writeは無料枠の9.3%、DO requestsは4.0%、Workers requestsは1.2%だった。Workers AIは10/25に451件・1,276.25 Neurons、10/29に6件・errorCode 5028・0 Neuronsを観測した。requestSourceはunknown、tagは空であり、Akatuki-Knowledge由来とは特定できない。これらをAkatuki単体の実績と誤認しない。

DOのGraphQL wallTimeはDO durationのGB-sと同じ指標ではない。Workers AI Neuronsも呼び出し元への帰属ができない。Cloudflare GraphQL Analyticsのread-only Account tokenはWorkerに接続されていないため、現時点の自己監査はD1に保存されたタスク・予約・Workers AI telemetryを中心に行う。

## 2. 現行のCloudflare Free枠

2026-10-30に公式Docsを確認。

| サービス | Free枠 |
|---|---:|
| Workers | 100,000 requests/day（Workflows executionと共有） |
| D1 | 5,000,000 rows read/day、100,000 rows written/day |
| Durable Objects | 100,000 requests/day、13,000 GB-s/day |
| Workers AI | 10,000 Neurons/day |
| Workflows | 100,000 executions/day（Workers requestsと共有）、3,000 steps/day |

公式資料:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

## 3. Workers AIのアプリ独自制限撤去

撤去した制限:
- 8,000 Neurons/dayのアプリ側予約ゲート（Cloudflare Free枠の80%）。
- 通常タスク20回・改善タスク5回などのmodel call count上限。
- 通常タスク40,000・改善タスク12,000などのtask AI token上限。
- 改善タスクの1回1,024 output token制限。
- 改善依頼の固定件数上限。

現行の動作:
- workers_ai_daily_usageはbest-effort telemetry。Neurons推定値とprovider usageを記録するが、予約失敗・テーブル不在・DB書き込み失敗でAIを拒否しない。
- provider usageが返れば実績を記録。応答なしの失敗は入力token推定分のみを計上し、出力token分を請求したことにしない。usageなし成功は過少計上を避けるため予約を残す。
- AIの最大出力はモデルの仕様上限と残りコンテキストに従う。これはCloudflareのFree quotaとは別のモデル制約。
- CloudflareのNeurons quota exhaustionを分類し、UTC 00:01まで待機して自動再開する。Cloudflareのerror code 3036（daily free allocation of 10,000 neurons exceeded）を日次枠到達として分類し、quota待ちは通常の失敗試行を消費しない。アプリ台帳の推定誤差や他Workerの使用量を根拠に、早期に止めない。
- Cloudflare側で無料枠超過が拒否された場合は待機する。課金・有料枠を有効化する動作はしない。

## 4. 別資源の受付制御

Workflows Free枠は3,000 steps/day。現行は1タスク32 stepsを予約し、2,700 steps/dayまで受付する。300 stepsは他用途・予測誤差の余白として残す。これはWorkflow実行量の厳密な予測ではなく、固定予約による受付ゲートである。タスク件数の固定上限ではない。

通常タスクのclaim/retry、改善タスクの通常最大4実試行・最大8時間、lease、idempotencyはタスクの回復・重複実行・無限retryを防ぐライフサイクル制約であり、Workers AI利用量の独自上限とは区別する。Workers AIの日次quota待ちはattemptを消費せず、deadlineを次回実行可能時刻+1時間まで延長する。将来、実際のWorkflow stepsと失敗時の未使用分を精算できれば、予約見積もりを実消費に近づける。

D1 rows read/write、Workers requests、DO requests/GB-s、Workflow executionsなどはCloudflare側のFree quotaが最終ゲート。GraphQL Analyticsの全アカウント集計とWorker固有の計測を混ぜない。

## 5. 定期自己監査と改善実装

日次Cron（UTC 23:55）がbudget self-auditを実行する。対象はD1 task status、error class、Workflow予約steps、Workers AI telemetry。監査結果はapp_metaのUTC日単位キーで冪等保存する。

毎日Notes/改善/に自己監査ノートを作る。ノートはorigin: budget-audit、audit_generated: trueを持ち、通常の改善ノート起票・実装経路に渡る。自己監査の再帰起動は行わない。日次監査が同じ日に複数回ノートを作らない。

改善エージェントはリポジトリ全体のコード・テスト・CI・migration・Wrangler設定を読み、根拠に基づいて必要な修正を計画する。許可された変更はPRにまとめ、関連する実装・テスト・pending migration・ドキュメントを分割して先送りしない。必要な変更がなければ無意味なPRを作らず、理由を記録する。

実装可能範囲:
- src/、scripts/、tests/、docs/、schema-snapshots/。
- migrations/pending/への新規SQL。
- wrangler.toml、package.json、package-lock.json、README.mdの既存ファイル更新。
- 安全条件を満たす新規GitHub Actions workflowファイル（read-only権限のみ）。既存のauto-merge.yml、check.yml、deploy.ymlは保護する。
- branch作成、ファイル作成・更新・unified diff適用、PR作成。

実行禁止:
- mainへの直接push、PR mergeの直接実行、release、deploy、本番migration適用、ファイル削除、権限変更。
- protected workflowの変更。
- write権限やsecrets参照を持つ自己生成workflow。

## 6. Purge方式のsquash auto-merge

.github/workflows/auto-merge.ymlはPurgeの設計を踏襲する。pull_request_targetでopened / reopened / ready_for_review / synchronizeを受け、Draftを除外し、PR作成者とイベント実行者を検証する。Dependabotはfetch-metadataのsemver update typeを確認し、既知のpatch/minor/majorだけ自動マージ対象とする。

自動マージはgh pr merge --auto --squashで要求し、必須status checksが成功するまでGitHubに待機させる。自己改善executorはGitHub GraphQL enablePullRequestAutoMerge(SQUASH)を呼ぶ。AI自身の自己評価をマージ許可の根拠にしない。branch protection / required checksが最終判定を行い、必須チェックを迂回しない。

## 7. Production rollout / 未完了事項

- PR CIでnpm run check、Agent domain tests、Worker dry-run build、pending migration validationを実行する。
- migrations/pending/にSQLが残っている間、deploy workflowはproduction deploymentを停止する。
- production D1のmigration ledger/schemaがmainのmigration chainと一致することを別途照合する。
- migration適用とWorker deployは、オーナーによるレビュー・承認を経て別手順で実行する。
- GraphQL Analyticsのread-only tokenは未接続。D1 telemetryはCloudflareアカウント全体の完全な使用量計測ではない。
- Workflow固定32-step予約は実消費量ではない。実消費量計測・予約精算は将来の改善候補として残す。
- AI quota exhaustionのCloudflare provider error表現が変わった場合は、分類テストと自動再開判定を更新する。

## 8. 実装ブランチで追加した運用上の要件

- 日次監査はUTC 23:55に毎日実行し、異常の有無にかかわらず自己監査ノートを1日1件作成する。定量メトリクスの警告と、コード・CI・migration・quota・回復経路のリポジトリ監査を同じノートで扱う。
- 監査レポートは認証済みGET /api/budget-auditから取得できる。D1のworkers_ai_daily_usageが未適用でもAI処理は止めず、レポート上でtelemetry unavailableとして扱う。
- 改善Inboxはupdated_at/idのkeyset cursorで30ノートずつ走査する。30件を超えるバックログも次回以降に巡回し、先頭30件だけを繰り返すstarvationを防ぐ。
- Workflow日次予約2,700 stepsを使い切った場合、新しいタスクをfailedにせずqueuedとして保存する。next_attempt_atを翌UTC日00:01にし、deadlineも延長する。15分ごとのrecovery Cronが翌日の空き枠を予約してWorkflowを起動する。既存のdaily_workflow_budget_exhausted terminal rowも再キューできる。
- Workers AIのmodel call count・tool call countにアプリ独自の上限を置かない。モデルcontext window、Cloudflare Workflow/D1の実クォータ、重複tool call検出、payloadサイズは実行環境と安全性の制約として残す。
- 大きな既存ファイルを編集できるよう、github_read_fileはstart_line/end_lineによる行範囲読み取りをサポートする。apply_patchはblob SHAを照合した後にunified diffを適用し、巨大なsrc/index.jsを全量再生成しない。計画全体は最大500,000文字、1ファイル本文200,000文字、差分100,000文字。操作件数の固定上限は設けない。
- .github/workflows/auto-merge.ymlはPurgeと同じpull_request_target + gh pr merge --auto --squash方式。Dependabotの既知semver更新と、作成者/イベント実行者がともにAkatuki1121である非Draft PRだけを対象にする。自己改善PRはexecutor側でもGraphQL auto-mergeを要求し、GitHub必須チェックとBranch Protectionを迂回しない。
- 自己改善エージェントが変更できるのはsrc、scripts、tests、docs、schema-snapshots、migrations/pending、および明示許可したroot config。既存のauto-merge.yml/check.yml/deploy.ymlは保護し、新規workflowもread-only権限以外は禁止する。
- 本番D1 migration 0016〜0018の適用・照合とWorker deployは別途オーナー承認が必要。pending migrationが残る間はDeploy workflowが本番deployを停止する。Workflow予約コードと本番D1の2000-step CHECK制約不一致は、0017適用まで残る既知の制約。
