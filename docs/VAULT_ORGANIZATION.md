# 保管庫の整理自動化（段階1: 記録と分類だけ）

Notes/Inbox に溜まったノートを内容に応じて扱う仕組みのうち、段階1
（記録と分類だけ、何も変更しない）の運用文書。設計の土台は設計書
「保管庫の整理自動化の設計（理想からの逆算）」で、段階の分け方は
その §9 に従う。

## 段階1でやること・やらないこと

- やること: Notes/Inbox のノートを走査し、1件ごとに「どの段の、どの
  扱いが、どの根拠で当たるか」を分類して、集計と印を記録する。
- やらないこと: ノートの移動・書き換え・作成・削除は一切しない。
  分類の結果がどうであれ、ノートの姿は変わらない。巡回の書き込みは
  app_meta だけである（`scripts/check-vault-organization-contract.mjs`
  がこの契約を固定している）。

## 起動の形

新しい cron は足していない。取り込み（pull）が成功した後に走る
`runPostPullAutomation`（`src/index.js`）の中で、改善の巡回
（`runImprovementInbox`）と並べて `runVaultOrganizationScan` を呼ぶ。
pull の頻度そのものが既存の適応形で調整されているため、巡回の頻度も
それに追随し、静かな保管庫では巡回も走らない。手動 pull
（POST /sync/pull）の後でも同じ自動化が走る。

巡回の本体は `src/vault-organization-store.mjs` の
`scanVaultOrganizationInbox` で、分類規則は
`src/vault-organization-rules.mjs`、Workers AI の呼び出しは
`src/index.js` の `classifyVaultNoteWithAi` が注入する。

## 巡回の流れ（1回分）

1. app_meta のカーソル（`vault_organization_cursor`）から続きを読み、
   Notes/Inbox 配下のノートを `updated_at, id` 昇順に最大で処理上限
   （10件）まで取る。
2. 1件ごとに、常時除外 → 猶予 → 処理済みの印 → 第0層の規則 →
   （決まらなければ）第1層の Workers AI、の順で分類する。
   - 常時除外（規則 X1・X2）はパスと題だけで判定し、本文は開かない。
     認証情報を含むノートと、コンフリクト名のファイルが対象。
   - 猶予: 更新から2時間が経っていないノートはその回は分類せず、
     カーソルをその手前で止める。次回に必ず再走査される。
   - 処理済みの印は app_meta のキー
     `vault_organization_seen:<sha256>`（材料は sync_uuid と
     content_hash で、改善の巡回と同じ作り方）。本文が変われば印の
     キーが変わり、再分類の対象になる。
   - 取得できない・同一性が組めないノートは「空のノート」と
     読み違えず、その回は扱わず、カーソルも進めない。
3. 集計を app_meta の日次キーへ加算し、巡回の要約を構造化ログに出す。
   一覧の最後まで届いたらカーソルを消し、次回は先頭から（印で
   処理済みを飛ばして）再走査する。

分類の層:

- 第0層（符号の規則、`src/vault-organization-rules.mjs`）: K1 日常の
  記録、K2 フォルダ名そのものの一致、K3 題材語の対応表（一意に
  決まる組だけ）、K4 ウェブクリップの型（段2の候補、宛先は決めない）。
  競合する語（原ゼミ、GPIO 等）は規則では決めない。宛先の集合から
  AI共有と「私について」は外してある。
- 第1層（Workers AI）: 規則で決まらないものを、題と本文の冒頭800字
  だけで一次振り分けする。送信直前に `inspectAndRedact` の伏字を
  適用し、認証情報が検出された材料は送らない。全文は渡さない。
  応答は `{target, confidence, reason}` の JSON で、確信度は段階1
  では線を引かず分布だけを取る。
- 第2層（Muse）: 段階1の Worker 内では消費ゼロ。規則でも AI でも
  決まらなかった件数を `claude_pending` として数えるだけに留める。

`ai_allowed` ではノートを遮断しない（2026-11-09 の所有者決定で撤去
されたゲートを持ち込まない）。

## 記録の置き場所と実測の読み方

段階1の前半は、既存の D1 構造（app_meta）に寄せて記録する。

| キー | 中身 |
| --- | --- |
| `vault_organization_cursor` | 巡回のカーソル `{updatedAt, id}` の JSON |
| `vault_organization_seen:<sha256>` | 処理済みの印（値は `1`） |
| `vault_organization_stats:<YYYY-MM-DD>` | 日次集計の JSON（日付は UTC） |

日次集計の項目: `scanned`（走査）、`excluded`（常時除外）、
`deferred`（猶予で見送り）、`failed`（取得失敗等で扱えなかった）、
`rule_decided`（規則で決まった）、`ai_called`（Workers AI を呼んだ）、
`ai_decided`（AI が宛先を返した）、`undecided`（段0になった）、
`claude_pending`（第2層行き）、`ai_neurons`（AI 呼び出しの Neurons
実績の合計）、`confidence_buckets`（確信度を0.1刻みで数えた度数）、
`runs`、`duration_ms_total`、`processed_total`。

読み口の API は段階1では足していない。実測の確認は、読み取り専用の
D1 確認（リポジトリの決まりで許可されている範囲）で行う。例:

```sh
npx wrangler d1 execute Akatuki-knowledge --remote \
  --command "SELECT value FROM app_meta WHERE key = 'vault_organization_stats:2026-11-15'"
```

AI の費用は、上の `ai_neurons` と、台帳 `workers_ai_daily_usage` の
当日の `actual_neurons` を付き合わせて読む。

## 上限と初期値（R7）

いずれも段階1の実測で置き換える前提の初期値で、符号の中では名前付き
の定義に寄せてある（`src/vault-organization-store.mjs`）。

| 項目 | 初期値 | 置き場所 |
| --- | --- | --- |
| 1回の巡回の処理件数 | 10件 | `VAULT_ORGANIZATION_SCAN_LIMIT` |
| 1回の巡回の AI 呼び出し | 10件 | `VAULT_ORGANIZATION_AI_CALLS_PER_RUN` |
| 1日の AI 呼び出し | 30件 | `VAULT_ORGANIZATION_AI_CALLS_PER_DAY` |
| 猶予時間 | 2時間 | `VAULT_ORGANIZATION_GRACE_MS` |
| AI へ渡す冒頭 | 800字 | `VAULT_ORGANIZATION_AI_HEAD_CHARS`（rules 側） |
| AI の出力上限 | 512トークン | `VAULT_ORGANIZATION_AI_MAX_OUTPUT_TOKENS`（rules 側） |

上限を超えた分は次回へ回し、黙って上限は広げない。

## 判断点として残っているもの

- J5: 件ごとの構造化記録（R6: 対象パス、段、根拠、実行前後の
  contentHash、成否を後から棚卸しできる形）は、既存の D1 構造には
  寄せられなかった。最小の追加は新しいテーブル
  `vault_organization_records` 1つで、SQL 案と読み口
  （GET /api/organization/records）の追加は仕様書 §2.3 にある。
  段階1のこの文書の実装には含まれていない。マイグレーションの
  適用は人間の手順で行い、`migrations/pending/` に SQL がある間は
  デプロイゲートが止まる段取りも含めて、判断を待つ。
- J3: 確信度の線（自動の段へ進める境目）は未確定。段階1では線を
  引かず、`confidence_buckets` の分布を材料として取る。
- J6: 日常の判定規則（K1）の具体形は未確定。段階1では候補として
  記録するだけに留まる（元々実行しないため実害は無い）。
- J7: 猶予時間と頻度の具体値は未確定。猶予は初期値2時間で回し、
  `deferred` の件数と分類時点の経過時間を材料にする。
