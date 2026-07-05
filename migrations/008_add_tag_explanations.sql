-- migrations/008_add_tag_explanations.sql
-- 難しい用語タグのAI解説をキャッシュするための列を追加

ALTER TABLE tags ADD COLUMN IF NOT EXISTS is_difficult boolean;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS explained_at timestamptz;
