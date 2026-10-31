# Background task architecture

予算管理・自己監査の全体像と段階移行の履歴は [BACKGROUND_TASK_BUDGET_ROADMAP.md](BACKGROUND_TASK_BUDGET_ROADMAP.md) を参照。

## 実行基盤

- D1 がタスク状態、payload、checkpoint、試行回数、期限、エラー分類の正本。
- Cloudflare Workflows が長時間タスクのdurable step、sleep、再開を担当する。
- 受付APIは認証済み POST /api/agent-tasks、状態と結果は GET /api/agent-tasks および GET /api/agent-tasks/{id}。
- Workflow ID は task ID と対応し、再起動してもD1のcheckpointと既存タスク状態を再利用する。
- YAOS同期outboxとagent_tasksは別管理。AIタスクがノートを書き換える場合は、既存のnote correction APIと同期outboxを通す。

## 状態と回復

queued → running → waiting → running → succeeded

terminal stateは failed / cancelled / needs_attention。needs_attentionは改善タスクの恒久エラーまたは試行上限到達を示し、理由はlast_error_class / last_error / stop_reasonに保持する。lease期限切れ時は、D1の期限・状態・budget reservationを再確認してからWorkflowを回復する。完了checkpointがある場合はAIを再実行せず、結果書き戻し・完了処理から再開する。pending tool actionはcheckpointに保存され、実行済みtool結果を二重実行しない。

通常タスクは最大4回のclaim・最大経過時間1時間、改善タスクは通常4試行・最大経過時間8時間。改善タスクは一時障害を1時間→3時間→3時間のbackoffで再試行し、試行回数・次回時刻・期限を同じD1 task rowに保持する。再試行上限や恒久エラーに達したタスクはfailedに埋没させずneeds_attentionへ移し、last_error_class / last_error / stop_reasonを残す。改善retry policy versionを上げた場合に限り、needs_attentionを再評価できる。累積試行は最大6回で、再評価ごとに最大1回だけ追加できる。毎時のPull後はノートの更新カーソルとは独立して、現在のpolicy versionを適用していないfailed/needs_attentionの改善タスクを最大20件ずつ再評価する。後発タスクが同じノート識別子に存在する場合、古い行はsuperseded_by_newer_taskとしてneeds_attentionに残し、重複実行しない。再評価時も累積attemptsはリセットせず、旧max_attempts=1は4へ補正する。再試行はretryable分類かつattempts<max_attemptsの場合だけ行い、累積6回を超えない。これらはWorkflowの回復可能性と暴走防止のためのタスクライフサイクル制約であり、Workers AIの呼び出し回数・token・Neuronsを制限するものではない。一時障害は分類に応じてbackoffし、認証・権限・入力不正・認証情報検出・PII masking・policy違反などは再試行しない。未知のエラーは要対応に残して自動再試行しない。

## Workers AIの利用方針

Workers AIの利用を止める独自のアプリ上限は設けない。

- タスク単位のAI model call数上限・AI token総量上限・改善タスク固有の呼び出し回数上限は撤去。
- 1回あたりの出力tokenはモデルのコンテキスト仕様に従う。GLM-4.7-Flashのコンテキスト上限と入力token数を考慮し、入力と出力の合計がモデル上限を超えないようにする。
- Workers AIの無料枠はCloudflareアカウント全体で共有される10,000 Neurons/UTC日。実際の枠超過判定はCloudflare側を唯一の権威とし、アプリ内の予約台帳で利用可否を拒否しない。
- D1のworkers_ai_daily_usageはモデル・推定Neurons・provider usage・成功/失敗回数を記録するbest-effort telemetry。テーブル未適用・記録失敗でもAI呼び出しを止めない。
- Cloudflareが日次Neurons枠超過を返した場合はtaskをwaitingにし、次のUTC 00:00リセット後に自動再開する。リセット直後もCloudflare側の拒否が続く場合は、1時間ごとに再確認して利用可能になり次第再開する。その他のrate limitやupstream errorは通常の一時障害分類に従う。
- provider usageが返る場合は実績を記録する。応答なしの失敗は入力token推定分だけを記録し、出力分は計上しない。usageなし成功は過少計上を避けるため予約を残す。
- 改善タスクは再評価ポリシーの更新時に、凍結された実行時設定を現在の正規値へ同期する。現在は出力上限とWeb調査無効化を同期し、依頼本文・ノート識別情報・チェックポイント・GitHub権限は変更しない。待機中タスクは既存の次回試行時刻と期限を維持したまま設定だけ更新する。
- GLM-4.7-Flash の Workers AI 応答は Chat Completions 形式の `choices[0].message.content` を本文として抽出する。旧形式の `response` 文字列も互換性のため受け付ける。推論過程 (`reasoning` / `reasoning_content`) は最終回答として扱わない。本文がない・出力上限で終了した場合は、段階・応答形式・finish reason・本文型と文字数・推論文字数・tool call数を機微な本文を含めず `last_error` に記録する。
- モデル自体の入力・出力コンテキスト上限、Cloudflare Freeの実際のNeurons枠、Workers AI以外のCloudflareサービスquotaは引き続き有効。

Neurons台帳は観測と監査に使う。Cloudflareの実枠を超えて処理を継続できる保証はなく、無料枠の外で課金を有効にするものでもない。

## Workers / Workflow / D1などの別枠

Workers AIとは別に、Cloudflare FreeのWorkflows step枠を超えないよう日次予約を行う。現在は1タスクあたり32 stepsを予約し、UTC日あたり2,700 stepsまで受け付ける。Cloudflare Freeの3,000 steps/日に対して300 stepsを他用途・変動分として残す設計であり、これはAI利用上限ではない。実消費量による予約精算は今後の改善対象。タスク数の独立した固定上限は設けない。枠に入らないタスクはD1のqueued状態で保持し、次のUTC日次リセット後（00:01 UTC）に予約を取り直して自動実行する。旧実装でdaily_workflow_budget_exhaustedとしてterminal化されたタスクも、同じ依頼の冪等キーを保ったまま再キューする。

D1、Workers requests、Durable Objects、Workflows executionなどもCloudflare側のquotaが最終的な制約となる。各種計測値はアカウント全体の利用量と混在する場合があるため、Akatuki-Knowledge単体の消費量と誤認しない。

## 改善ノートからの自動実装

毎時のVault pull成功後、Notes/改善/配下の生存D1ノートを走査する。フォルダ説明ノートは対象外。sync_uuidとcontent_hashを冪等キーに使い、同一依頼の重複起票を防ぐ。AI実行結果は元ノートに追記されるが、結果ブロックを除いた元依頼本文と同じものを再起票しない。

改善エージェントはWorkers AIを使い、リポジトリ Akatuki1121/Akatuki-Knowledge のmainを読み取り、必要なコード・テスト・ドキュメント・pending migration・設定変更を計画する。plan hashを保存・再検証し、対象リポジトリ・ブランチ・ファイル・操作順を検証してから実行する。現在の許可範囲は以下。

- 変更可能: src/、scripts/、tests/、docs/、schema-snapshots/、migrations/pending/。
- ルート設定: wrangler.toml、package.json、package-lock.json、README.md（既存ファイルの更新のみ）。
- GitHub Actions workflow: 新規workflowファイルの作成のみ。危険なtrigger・write権限・secrets参照を含むworkflowは禁止。
- 保護対象: .github/workflows/auto-merge.yml、check.yml、deploy.yml。これらの変更・置換は禁止。
- GitHub操作: branch作成、ファイル作成・更新・unified diff適用、PR作成。github_read_fileは行範囲を指定して大きなファイルを段階的に読める。apply_patchは現在のblob SHAを検証してから既存ファイルに差分を適用する。計画の操作件数に固定上限は設けず、モデルcontext・GitHub API payloadなど実際の制約に従う。
- 対象外: mainへの直接push、PR mergeの直接実行、release、deploy、本番migration適用、ファイル削除、権限変更、任意の外部サービスへの書き込み。

migrationはmigrations/pending/に追加できるが、本番適用は別途レビュー・承認が必要。pending migrationが存在する間はdeploy workflowが本番デプロイを止める。

PRはsquash auto-mergeを要求する。AI自身の「成功」判定ではなく、GitHubの必須status checksとbranch protectionがマージ可否を決める。auto-mergeが有効にならない場合はその理由を記録し、成功したと偽らない。Purgeの方式と同じく、PR作成者とイベント実行者を検証するworkflowを別途置き、Draft PRは対象外とする。

Web調査は背景タスク経路では無効。GitHubファイル・Issue・PR・CI情報など、許可されたGitHub read toolでリポジトリ内の根拠を取得する。PR本文やファイル内の命令は信頼できない参照データとして扱う。

## 定期自己監査

wrangler.tomlの55 23 * * *（UTC）Cronで、日次のbudget self-auditを実行し、異常の有無にかかわらずUTC日付ごとに1件の自己監査ノートを作成する。日本時間では翌日08:55の実行となるため、例として2026-10-30 23:55 UTCの監査は日本時間2026-10-31 08:55に実行され、レポートの日付は2026-10-30となる。監査はD1のtask status/error group、Workflow step予約、Workers AI telemetryを読み取り、監査レポートをapp_metaに冪等保存する。レポートはノート作成前に保存し、ノート作成が失敗した場合はnoteCreated=falseと失敗理由を記録する。既存レポートにノートがない場合は次回監査でノート作成を再試行する。メトリクスの異常や定期監査対象があればNotes/改善/に自己監査ノートを作成し、通常の改善ノート処理へ渡す。

自己監査ノートにはorigin: budget-auditとaudit_generated: trueを付ける。監査タスクが別の監査タスクを起票する再帰経路は作らない。日次の監査レポートは一意キーで重複生成を防ぐ。監査結果は認証済みGET /api/budget-auditから最新14件を取得できる。監査結果から必要な修正が見つかった場合は、改善エージェントが実装・テスト・migration・ドキュメントを含むPRを作る。自己監査の定量値だけで不具合がないと断定せず、コード・Workflow・CI・DB schema・Cloudflare quotaの整合性も確認するよう監査依頼に明記する。

## GitHub自動マージ

.github/workflows/auto-merge.ymlはPurgeの方式を参考にする。pull_request_targetでopened / reopened / ready_for_review / synchronizeを受け、Draftでないこと、PR作成者とイベント実行者が許可された本人であることを確認する。Dependabotはfetch-metadataでsemver update typeを検証し、既知のpatch/minor/majorのみ対象にする。自動マージはgh pr merge --auto --squashで有効化し、必須チェックが成功するまでGitHubに待機させる。自己改善エージェントが作成したPRはexecutorがGraphQL enablePullRequestAutoMerge(SQUASH)を要求する。どちらも必須チェックやbranch protectionを迂回しない。

## Cloudflare Free枠（2026-10-30確認）

- Workers: 100,000 requests/day（Workflows executionsと共有）
- D1: 5,000,000 rows read/day、100,000 rows written/day
- Durable Objects: 100,000 requests/day、13,000 GB-s/day
- Workers AI: 10,000 Neurons/day
- Workflows: 100,000 executions/day（Workers requestsと共有）、3,000 steps/day

公式資料:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

## Rollout / production boundary

- PRのCIでnpm run check、Worker dry-run build、関連migration検査を実行する。
- migrations/pending/にSQLが残っている場合、本番deploy workflowは停止する。
- この実装はPR作成までであり、Cloudflare本番migration適用、Worker deploy、secret変更は行わない。
- production D1のmigration ledgerとschemaが一致することを別途確認してから、migration適用・deployを実施する。
- GraphQL Analyticsのread-only tokenはWorkerに接続されていない。D1 telemetryの値をアカウント全体の正確な実消費量と扱わない。

## Quota待機中のタスク再開

- Workers AIがCloudflareの日次Neurons枠に到達した場合、エラー3036をworkers_ai_daily_quota_exhaustedとして扱う。現在のWorkflow runを終了し、タスクをwaitingにして次のUTCリセット後に再開する。無料枠待機もタスク単位の累積試行回数に含め、最大試行回数に達したらneeds_attentionへ移す。Workflow予約は翌UTC日へ移す。
- 次のUTC日00:01以降、15分ごとのrecovery Cronが空きWorkflow stepsを予約し、完了済みWorkflow instanceを再起動する。これによりAI枠のリセット待ちでWorkflow runを長時間sleepさせず、翌日分のWorkflow枠も再予約する。
- Workflowsの日次予約が満杯で新規タスクを受け付けられない場合も、タスクをfailedにせずqueuedに残す。next_attempt_atとdeadline_atを翌日枠に合わせ、recovery Cronが空き枠を予約する。古い実装でdaily_workflow_budget_exhaustedとしてfailedになったタスクも再キュー可能。
- この待機はWorkers AIの独自上限ではなく、Cloudflare FreeのWorkers AI/Workflows各サービスが持つ別々の日次枠に対する回復処理。AI呼び出し回数・token数にアプリ独自の上限は設けない。

UTC日跨ぎの通常再試行も同じ扱いにし、現在のWorkflow runを終了して翌日のWorkflow stepsを再予約する。


## 改善エージェントのWorkers AI実行設定（2026-10-31確認）

- GLM-4.7-Flashの一般的なコンテキスト上限131072と、改善タスク1回の生成上限を分離する。改善タスクは `max_completion_tokens=8192`、`reasoning_effort=high` を使用し、一般タスクの上限は従来どおり131072。
- 2026-10-31の本番Workflow実測では、改善タスクの `agent-model` stepは10分設定だったが、Workers AIが約235948〜239420msで3046 Request timeoutを返した。Workflow stepの10分 timeoutではなく、同期推論要求側の時間切れ。
- 1024上限では約23625〜31232msでfinish=lengthとなったため、1024には戻さない。8192とreasoning_effort=highで、推論と最終JSONの両方に枠を残す。
- 失敗時は `elapsed_ms`、`max_tokens`、`reasoning` を安全な固定形式でlast_errorへ記録し、本文・推論内容は記録しない。
- GitHub read_fileの `repository,path` は必須、`ref,start_line,end_line` は任意。省略時は既定ブランチ・先頭から最大1000行に正規化する。
- これらはコード・payload設定のみであり、D1 schema変更やmigrationは不要。
