-- 保管庫の整理自動化の件ごとの構造化記録 (設計 R6)。
-- 1件ごとに、対象パス、扱いの段、根拠、実行前後の contentHash、成否を
-- 残し、後の棚卸しと所有者の確認に使える形にする。
-- 適用はレビュー済み手順に基づき人間が行う。このファイルが
-- migrations/pending/ にある間、GitHub Actions は本番デプロイを止める。
CREATE TABLE vault_organization_records (
  record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  sync_uuid TEXT,
  path TEXT NOT NULL,
  content_hash_before TEXT,
  content_hash_after TEXT,
  stage INTEGER NOT NULL,
  action TEXT NOT NULL,
  basis_kind TEXT NOT NULL,
  basis_detail TEXT,
  target_path TEXT,
  confidence REAL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_vault_organization_records_note
  ON vault_organization_records(note_id, created_at DESC);

CREATE INDEX idx_vault_organization_records_created
  ON vault_organization_records(created_at DESC);
