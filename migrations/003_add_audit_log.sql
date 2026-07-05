-- migrations/003_add_audit_log.sql
-- M4: 監査ログテーブルを追加する

CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  table_name text NOT NULL,
  record_id int,
  action text NOT NULL,
  actor text,
  before jsonb,
  after jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
