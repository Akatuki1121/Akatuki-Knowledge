# 保管庫の整理自動化（段階2: 記録と、段1・段2の自動実行）

Notes/Inbox に溜まったノートを内容に応じて扱う仕組みのうち、段階2
（件ごとの記録と、段1の移動・段2の空白正規化の自動実行）の運用文書。
設計の土台は設計書「保管庫の整理自動化の設計（理想からの逆算）」で、
段階の分け方はその §9、段階2の範囲の絞りは §13 に従う。段階1
（記録と分類だけ）は PR #224 で本番稼働中。

## 段階2でやること・やらないこと

- やること: Notes/Inbox のノートを走査し、1件ごとに分類して、分類と
  実行の結果を件ごとに `vault_organization_records` へ記録する。
  そのうえで、次の2つだけを自動実行する。
  - 段1の移動: 分類が第0層の規則で決まったものだけを、同一性を保つ
    移動の経路で実行する。
  - 段2の整形: K4（ウェブクリップの型）で段2候補になったノートに、
    空白の正規化（行末の空白の除去、3行以上の連続空行を1行へ、
    末尾の改行を1つに）だけを実行する。
- やらないこと:
  - 削除は一切実行しない。重複や空になったノートは案の側に留める。
  - AI の分類だけで決まった段1は実行しない（記録だけ）。
  - 空白以外の整形（ウェブクリップの定型部分の除去等）はしない。
  - 移動が拒否された場合に、作り直し＋削除へは落とさない。失敗と
    して記録し、段0に留める。
  - 記録テーブルが無い・記録が書けない間は、実行しない。巡回は
    段階1の挙動（分類と集計だけ）で壊れずに回る。

## 起動の形

新しい cron は足していない。取り込み（pull）が成功した後に走る
`runPostPullAutomation`（`src/index.js`）の中で、改善の巡回
（`runImprovementInbox`）と並べて `runVaultOrganizationScan` を呼ぶ。
pull の頻度そのものが既存の適応形で調整されているため、巡回の頻度も
それに追随し、静かな保管庫では巡回も走らない。手動 pull
（POST /sync/pull）の後でも同じ自動化が走る。

巡回の本体は `src/vault-organization-store.mjs` の
`scanVaultOrganizationInbox` で、分類規則と空白の正規化は
`src/vault-organization-rules.mjs`、Workers AI の呼び出しと段階2の
実行関数は `src/index.js` が注入する。実行関数は公開 API の経路
（移動は `moveNote`、書き戻しは `correctNote`）を内部呼び出しする
形で、巡回と規則の側はノートを変える呼び出しを直接持たない
（`scripts/check-vault-organization-contract.mjs` がこの契約を
固定している）。

## 巡回の流れ（1回分）

1. 記録テーブル（`vault_organization_records`）の有無を、巡回ごとに
   1回だけ安く確かめる（`sqlite_master` の参照）。無ければ記録なし・
   実行なしの形に倒れる。記録の書き込みが途中で失敗したら、その回は
   以後を記録なしに倒し、実行も止める。
2. app_meta のカーソル（`vault_organization_cursor`）から続きを読み、
   Notes/Inbox 配下のノートを `updated_at, id` 昇順に最大で処理上限
   （10件）まで取る。
3. 1件ごとに、常時除外 → 猶予 → 処理済みの印 → 第0層の規則 →
   （決まらなければ）第1層の Workers AI、の順で分類し、結果を
   1件ごとの記録として書く。
   - 常時除外（規則 X1・X2）はパスと題だけで判定し、本文は開かない。
     認証情報を含むノートと、コンフリクト名のファイルが対象。
   - 猶予: 更新から2時間が経っていないノートはその回は分類せず、
     カーソルをその手前で止める。次回に必ず再走査される。
   - 処理済みの印は app_meta のキー
     `vault_organization_seen:<sha256>`（材料は sync_uuid と
     content_hash）。本文が変われば印のキーが変わり、再分類の
     対象になる。
   - 取得できない・同一性が組めないノートは「空のノート」と
     読み違えず、その回は扱わず、カーソルも進めない。
4. 分類に続けて、実行の条件を満たすものだけを実行する（次の節）。
5. 集計を app_meta の日次キーへ加算し、巡回の要約を構造化ログに出す。
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
  応答は `{target, confidence, reason}` の JSON。確信度の線の初期値は
  0.85（J3。段階4で実測から調整する）。
- 第2層（Muse）: Worker 内では消費ゼロ。規則でも AI でも決まら
  なかった件数を `claude_pending` として数え、記録の basis_kind にも
  `claude_pending` として残す。

`ai_allowed` ではノートを遮断しない（2026-11-09 の所有者決定で撤去
されたゲートを持ち込まない）。

## 実行の条件と照合

実行は、そのノートの分類の記録が書けた場合に限る。記録が書けない
ノートは実行しない。

段1の移動（規則で決まったものだけ）:

- 実行直前にノートを取り直し、パス・sync_uuid・contentHash が分類
  時点と一致することを照合する（R2）。変わっていたら実行しない。
  移動の経路側でも `expectedContentHash` で前提照合する。
- 移動後に、移動先のパスと、sync_uuid と contentHash が不変である
  ことを照合して記録する（R3）。照合に失敗したら失敗として記録
  する。

段2の整形（空白の正規化だけ）:

- 正規化した前後の文章が、空白を取り除いた文字列として一致し、
  空白でない行の並びが保たれることを機械照合する（R4）。通らない
  場合は実行しない。
- 書き戻しは安全な更新の形（旧本文は note_revisions へ残り、同一
  内容なら書かない）に従い、書き戻し後に保存された本文が意図した
  正規化形と一致することを照合する。

実行の件数は、巡回の処理上限（10件）の内側に収まる。猶予・常時
除外・上限は段階1のまま。

## 記録の置き場所と実測の読み方

件ごとの記録は新しいテーブル `vault_organization_records` に置く
（設計 R6）。1行が1件の分類または実行で、対象パス、段、根拠
（basis_kind: excluded / grace / rule / workers_ai / claude_pending /
undecided と、その詳細）、実行前後の contentHash、確信度、成否を
持つ。

読み口は `GET /api/organization/records`（既存の認証の内側）。
`since` / `until`（created_at の範囲）、`basis_kind`、`action`
（classify / move / format）、`limit`（既定20、最大100）で絞れる。

テーブルの追加は `migrations/pending/0020_vault_organization_records.sql`
として置いてある。適用は人間の手順で行い、pending に SQL がある間は
デプロイゲートが本番デプロイを止める。テーブルが本番に無い間、この
コードは記録なし・実行なしの段階1の挙動で動き続ける。

集計と印は段階1から引き続き app_meta に置く。

| キー | 中身 |
| --- | --- |
| `vault_organization_cursor` | 巡回のカーソル `{updatedAt, id}` の JSON |
| `vault_organization_seen:<sha256>` | 処理済みの印（値は `1`） |
| `vault_organization_stats:<YYYY-MM-DD>` | 日次集計の JSON（日付は UTC） |

日次集計の項目: `scanned`（走査）、`excluded`（常時除外）、
`deferred`（猶予で見送り）、`failed`（取得失敗等で扱えなかった）、
`rule_decided`（規則で決まった）、`ai_called`（Workers AI を呼んだ）、
`ai_decided`（AI が宛先を返した）、`undecided`（段0になった）、
`claude_pending`（第2層行き）、`moved`（段1の移動を実行した）、
`formatted`（段2の整形を実行した）、`execution_failed`（実行が
失敗した）、`ai_neurons`（AI 呼び出しの Neurons 実績の合計）、
`confidence_buckets`（確信度を0.1刻みで数えた度数）、`runs`、
`duration_ms_total`、`processed_total`。

AI の費用は、上の `ai_neurons` と、台帳 `workers_ai_daily_usage` の
当日の `actual_neurons` を付き合わせて読む。

## 上限と初期値（R7）

いずれも実測で置き換える前提の初期値で、符号の中では名前付きの
定義に寄せてある（`src/vault-organization-store.mjs`）。

| 項目 | 初期値 | 置き場所 |
| --- | --- | --- |
| 1回の巡回の処理件数 | 10件 | `VAULT_ORGANIZATION_SCAN_LIMIT` |
| 1回の巡回の AI 呼び出し | 10件 | `VAULT_ORGANIZATION_AI_CALLS_PER_RUN` |
| 1日の AI 呼び出し | 30件 | `VAULT_ORGANIZATION_AI_CALLS_PER_DAY` |
| 猶予時間 | 2時間 | `VAULT_ORGANIZATION_GRACE_MS` |
| AI へ渡す冒頭 | 800字 | `VAULT_ORGANIZATION_AI_HEAD_CHARS`（rules 側） |
| AI の出力上限 | 512トークン | `VAULT_ORGANIZATION_AI_MAX_OUTPUT_TOKENS`（rules 側） |

上限を超えた分は次回へ回し、黙って上限は広げない。

## 判断点の決着と残り

- J5（件ごとの構造化記録）: 2026-11-15 に所有者が承認。テーブルと
  読み口を段階2に含めた。適用は人間の手順（上の節）。
- J2（段4の自動化）: 広げないことで確定。段4は案の側に留める。
- J3（確信度の線）: 初期値 0.85。段階4で分布と実行結果から調整する。
- J4（対象外フォルダ）: Notes/AI共有 と Notes/私については、対象
  からも宛先からも外すことで確定。
- J7: 猶予時間と頻度の具体値は未確定。猶予は初期値2時間で回し、
  `deferred` の件数と分類時点の経過時間を材料にする。
