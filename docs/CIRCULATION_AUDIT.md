# 「待っているもの」の巡回監査

## 目的と境界

毎日 07:30 JST に、待っているものの集合を機械的に点検する。ノート本文・パス・同期状態は読み取るだけで、ノートの作成・移動・削除・本文変更は行わない。結果は D1 の `audit_runs`、`audit_findings`、`audit_note_state` に保存する。通知文は `audit_runs.notification_text` に作成・保存するだけで、送信しない。

Workers AI、Telegram送信、YAOSの書き込みAPIは使用しない。監査が書き込むのは上記3つの監査用テーブルだけである。監査テーブルが未適用の場合は何も書かずにスキップする。

## 起動

`wrangler.toml` の `30 22 * * *`（UTC）で起動する。これは 07:30 JST に相当し、既存の 08:55 JST の予算自己監査とは別の処理である。既存の毎分 pull、15分ごとのタスク回復、自己監査の cron は維持する。

## 集合

2026-11-25 未明の本番 D1 実測を初期基準とする。集合の定義はパスの置き場とテーブル所属で機械的に切り出す。

- `notes`: `deleted_at IS NULL` かつ `Notes/Inbox/`、`Notes/タスク/`、`Notes/改善/`、`Notes/AI共有/`、`Notes/履歴/` のいずれかにある行。
- `telegram_notes`: `deleted_at IS NULL` の全行。パスがないこと自体を入口状態として扱う。
- `Notes/履歴/` は集合全体には含めるが、日次巡回からは外す。
- `yaos_sync_identity_review` に同じパスが残る notes 行は隔離する。日次巡回の実効対象から外し、巡回範囲に重なるものは `quarantined_overlap` として記録する。

実地確認時点では集合全体 385 件（notes 375、Telegram 10）、日次巡回の母数 45 件、隔離は集合内 8 件（うち日次巡回範囲 6 件、履歴 2 件）、実効巡回対象 39 件だった。これは 2026-11-25 未明のスナップショットであり、毎時 pull により件数は変動する。現在値として固定しない。

## 検査

閾値・対象ルートは `src/circulation-audit.mjs` 冒頭の `CIRCULATION_AUDIT_RULES` に集約する。将来ルールを Notes のノートから読む方式に差し替える余地を残すが、今回はノートからの読み込みを実装しない。初期閾値は14日。

- `stagnant`: 日次巡回対象の Obsidian ノートで、前回監査から content_hash が変わっておらず、`updated_at` が14日より古いもの。新規追加・hash変更を検出した回には滞留判定しない。
- `quarantined_overlap`: 日次巡回範囲内で同一性レビューに残るパス。レビュー理由と分類を detail に残す。
- `pathless_aged`: Telegram の live 行で `updated_at` が14日より古いもの。
- `set_out`: 前回集合に存在し、今回集合から外れたもの。finding を残した後、state 行を削除するため、同じ離脱を毎日重複記録しない。

`audit_note_state` は source と note_id で現在の集合を追跡する。初回集合入り時刻は継続し、last_seen_at は各監査で更新する。本文ハッシュの変化、新規集合入り、集合外への離脱を changed_count に合算する。履歴も状態追跡と set_out の検出対象に含む。

## テーブルと運用

- `audit_runs`: 監査1回の件数、成否、通知文、エラーコード。
- `audit_findings`: 監査ごとの4種類の検出結果。
- `audit_note_state`: 集合内ノートの前回ハッシュと集合入り・最終観測時刻。

マイグレーションは `migrations/0022_circulation_audit.sql`。2026-11-25に所有者承認のロールアウトで本番 D1 へ適用し、`d1_migrations` に記録済み（id 22）。
