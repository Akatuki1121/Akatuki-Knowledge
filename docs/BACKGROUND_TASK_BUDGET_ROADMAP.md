# Cloudflare予算管理・自己監査ロードマップ

確認日: 2026-10-30  
対象: Akatuki Knowledge Worker / D1 / Durable Objects / Workflows と YAOS  
前提: Akatuki Knowledge と YAOS は同じ Cloudflare アカウントの無料枠を共有する。

## 1. 調査結果

### 固定件数制限の定義箇所

| 制限 | 旧定義 | 現在 |
|---|---|---|
| 改善タスク | `src/agent-improvement-policy.mjs` の1日3件 | PR #174 で撤廃 |
| 改善タスク日次カウンター | `src/index.js` の `reserveImprovementTaskSlot` / `app_meta` | PR #174 で撤廃 |
| バックグラウンドタスク | `migrations/0011_agent_tasks.sql` の1日60件 | PR #174 の `0017` でDB制約を撤去 |
| Workflow予約 | 1件32 steps、旧2,000 steps/日 | PR #174 で2,700 steps/日に変更。32 steps/件の固定予約は残存 |
| Workers AI | PR #174 で8,000 Neurons/日を予約上限に設定 | 継続。無料枠10,000の80% |

PR #174 は3件・60件という固定件数の足かせを外したが、Cloudflareアカウント全体の実消費量を見て全資源を制御する完成形ではない。現在の2,700 steps/日は実際のWorkflow step数ではなく、タスクごとに32 stepsを予約する保守的なアプリ内予算である。Workers AIの8,000 Neuronsもコード内の固定値で、他Workerの消費量を自動取得していない。

### Cloudflare GraphQL Analytics（2026-10-23〜2026-10-29）

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

`Workflow starts` は `WORKFLOW_START` の件数。step数は状態別イベントが同じ実行を重複して表すため、この表では合算していない。DO requests は `akatuki-knowledge` と `yaos` の合計。Workers・D1・DOのアカウント内他サービスの利用も含む。

観測期間中の最大値を無料枠と比較すると、Workers requests は1,207/100,000（約1.2%）、D1 rows read は1,020,033/5,000,000（約20.4%）、D1 rows written は9,300/100,000（約9.3%）、DO requests は4,015/100,000（約4.0%）、Workflow starts は13/100,000（約0.013%）。この期間では、Workers/D1/DO/Workflowのアカウント全体使用量は無料枠に対して余裕があった。D1 read が相対的に最も高く、将来も無視してよいとは言えない。

Workers AIは10/25に451件・1,276.25 Neurons（入力75,606 tokens、出力8,976 tokens）が観測された。モデルは `@cf/meta/llama-3.1-8b-instruct-fp8`。10/29は6件、モデル `@cf/meta/llama-3.1-8b-instruct`、errorCode 5028、Neurons 0。いずれもGraphQLの `requestSource` は `unknown`、`tag` は空で、Akatuki Knowledge由来かを特定できなかった。したがってこの数値をAkatukiのAI実績として扱わず、アカウント全体の観測値として記録する。10/29の6件は失敗応答の可能性があるが、Neurons 0だけで消費ゼロとは断定しない。

DOのGraphQL `wallTime` はDO durationのGB-sと同じ指標ではないため、13,000 GB-s/日の利用率はこの調査では算出していない。Workers AIのNeuronsもモデル・呼び出し元の帰属ができず、7日間の実績から改善タスク1件あたりの消費分布を確定することはできなかった。直近20件のp90推定へ切り替えるには、タスク単位の実測台帳を先に整える必要がある。

### 公式無料枠（2026-10-30に公式Docsで再確認）

- Workers: 100,000 requests/日（Workflowsの実行数と共有）
- D1: 5,000,000 rows read/日、100,000 rows written/日
- Durable Objects: 100,000 requests/日、13,000 GB-s/日
- Workers AI: 10,000 Neurons/日、UTC 00:00リセット
- Workflows: 100,000 executions/日（Workers requestsと共有）、3,000 steps/日

参照:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

### 本番反映とD1スキーマの不一致（2026-10-30確認）

PR #174のマージ後、GitHub Actionsの本番Deploy workflow（run `41015689299`）は成功し、Workerコードはmain commit `cd4a9f5` で本番デプロイ済み。一方、本番D1を読み取り確認した結果、migration ledgerの最新は `0015_yaos_file_identity_map.sql`（id 15）のままで、次の状態だった。

- `agent_task_daily_budget` の本番CHECK制約は依然 `tasks_reserved BETWEEN 0 AND 60` / `workflow_steps_reserved BETWEEN 0 AND 2000`。
- `workers_ai_daily_usage` テーブルは存在しない。
- したがってPR #174のWorkerコードと本番D1スキーマは不一致。現在のWorkerはAI呼び出し前にNeurons台帳を予約するため、テーブル不在時はAI呼び出しがD1エラーで止まる。バックグラウンドタスクの60件/2,000 steps制約も本番DBに残っている。

これは未解消の本番互換性問題。今回のPRではmigration `0016`〜`0018` を `migrations/pending/` に置き、今後の自動デプロイをmigration適用まで停止させる。**本番D1への適用・Worker再デプロイはこのPRでは行わない。** オーナー承認のある別作業として、0016→0017→0018を適用し、ledgerとschemaを照合する必要がある。

## 2. 根本原因と失敗時の修正

根本原因は、Cloudflareのアカウント共有クォータを測らず、アプリ内で改善タスク3件/日・全体60件/日という固定件数を先に消費していたこと。失敗実行もその枠を消費し、改善ノートの内容が変わっても既存の失敗記録・seen記録が再実行を妨げる経路があった。

PR #174 で3件・60件の件数上限は撤去済み。今回の失敗精算PRでは次を修正する。

- Workers AI成功時は、usageが返る場合に予約を実トークンから計算したNeuronsへ精算する。
- 応答なしの失敗時は、入力トークン推定分だけを実消費として計上し、出力予約分を戻す。失敗呼び出し数も別カウンターに記録する。
- usageが返らない成功応答は過少計上を避け、予約を残す。
- タスク別トークン予算も、成功時はprovider usage、応答なしの失敗時は入力推定分へ精算する。AI呼び出し回数は返金しない（実際に試行した回数だから）。
- 改善タスクの一時障害は最大3回再試行（初回を含む合計最大4試行）、待機は1時間→3時間→3時間、最大経過時間8時間。AI呼び出し最大5回にはWorkflow stepの再試行も含める。
- 失敗・キャンセルした依頼は、同じ本文のまま再投入しない。内容が変更されれば新しいcontent hash/idempotency keyとなり、再実行対象になる。
- 恒久エラーは自動再試行しない。予算待ち状態の導入は次段階で扱う。

## 3. 段階移行ロードマップ

| 段階 | 内容 | 状態 |
|---|---|---|
| (1) 調査 | 固定上限の定義箇所、7日GraphQL実績、AI計測の帰属可能性を確認 | 完了 |
| (3) 失敗精算 | 失敗時のNeurons・タスクtoken精算、改善タスク再試行の修正 | このPR |
| (2) 影子運用 | 資源別日次台帳、タスク試行記録、自前集計、GraphQL照合、予算判定の影子記録 | 次の独立PR |
| (4) 新方式へ切替 | feature flag付きで実消費予算ゲートへ切替、巻き戻し経路を検証 | (2)の観測後 |
| (5) 全体制御 | Workers/D1/DO/Workflows/YAOS共有資源のBG配分、時間あたり制御、`/api/budget`、予算待ち表示 | (4)の後 |
| (6) 旧定数削除 | 1〜2週間の安定運用後、旧予約値・互換コードを削除 | 最後 |

影子運用では判定を記録するだけで、従来の動作を止めない。資源台帳はUTC日付×資源単位とし、自己集計とGraphQLアカウント実績を分けて保存する。GraphQLが3時間以上古い場合は節約側へ倒す。D1は `meta.rows_read/rows_written`、Workers AIはusage tokenとモデル単価、Workflowsは実行・step、DO/YAOSはbinding呼び出しとGraphQL値を記録する。GraphQLのアカウント全体値からBG実績を差し引き、前景確保量を算出する。

### オーナー判断待ち・接続待ち

- 暫定保険上限「15件/日＋3件/時」は未決定。実装しない。
- GraphQL Analyticsの読み取り専用APIトークンはWorker用に未接続。オーナーが発行するまでは自前集計だけで影子運用し、GraphQL欠落時は安全側へ倒す。
- Workers AI安全上限はPR #174で10,000の80%＝8,000 Neurons/日として導入済み。これは現行実装値であり、今後の配分設計で無断変更しない。

## 4. 自己監査（実装）

自己監査を `src/budget-self-audit.mjs` に実装した。UTC 00:00 / 12:00 の1日2回、Cloudflare Cronから実行し、集計結果を `app_meta` に保存する。認証済み `GET /api/budget-audit` から直近14件を取得できる。監査で改善対象が見つかった場合は、1日1件まで `Notes/改善/自動監査-YYYY-MM-DD.md` を生成し、既存の改善Inboxへ即時投入する。改善エージェントがコード調査・修正・テスト・PR作成まで実行する。

監査対象:
- 直近24時間のタスク件数・失敗件数・失敗率
- 失敗分類ごとの反復回数
- 当日の日次Workflow予約量
- 当日Workers AIの予約Neurons・実績Neurons・成功/失敗呼び出し数（台帳が存在する場合）

安全性:
- 監査は決定論的な集計のみで、Workers AIを呼び出さない（Neurons消費ゼロ）。台帳が欠けている場合は0とみなさず `unavailable` と記録する。
- 1日2スロット（UTC 00/12）の一意キーで重複保存を防ぐ。監査結果を監査入力にしないため、再帰起動しない。
- 監査本体はコード変更・Issue/PR作成・マージ・デプロイを行わない。改善対象がある場合だけ監査依頼ノートをD1とYAOS outboxへ登録し、既存の改善エージェントへ渡す。
- 警告閾値はWorkflow予約2,160/2,700 steps、Workers AI予約＋実績6,400/8,000 Neurons、同一失敗分類3回以上、直近24時間の失敗率30%以上かつ失敗5件以上。
- Cloudflareアカウント全体のWorkers/D1/DO/Workflows消費量とGraphQL Analytics照合は、Worker側接続が未完了のため監査対象外として明記する。

監査から実装までの流れは、監査結果に基づく依頼ノート生成 → 既存改善Inboxによるタスク起票 → 改善エージェントの調査・変更計画 → 許可範囲のコード変更・テスト → PR作成。改善PRの自動マージは無効化し、レビュー・マージ判断はオーナーに残す。1日1件の監査起点依頼、直近30日で最大3件の監査起点ノートに制限する。監査起点の依頼ノートは `origin: budget-audit` / `audit_generated: true` で識別し、自己監査の入力に戻さない。
