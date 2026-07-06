-- 収集ジョブ（cron / 手動 API / バックフィル）の実行履歴を記録するテーブル。
-- これまで fetched/inserted/skipped は Workers のログにしか残らず、失敗時の再実行判断が
-- できなかった。ジョブ完了・失敗のたびに1行ずつ記録する。

CREATE TABLE IF NOT EXISTS import_runs (
  id serial PRIMARY KEY,
  provider text NOT NULL,          -- qiita / zenn / note / blog / url
  trigger text NOT NULL,           -- cron / api
  status text NOT NULL,            -- succeeded / failed
  fetched int NOT NULL DEFAULT 0,
  inserted int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  error text,
  detail jsonb DEFAULT '{}',
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_runs_provider ON import_runs (provider, finished_at DESC);
