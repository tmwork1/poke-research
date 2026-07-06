-- migrations/018_add_items_ai_accepted.sql
-- 偽陰性（AIレビューで誤って棄却された記事）を後からレビューできるよう、棄却された記事も
-- items に保存する（案A、docs/plan/review-scripts-gaps-20260706.md #4）。棄却済みかどうかは
-- items.metadata->'ai'->>'accepted' にも記録されるが、一覧・検索側での絞り込みを速くするため
-- 専用の列として持つ（migrations/016 の link_status 追加と同じ考え方）。
-- ai_accepted: true（既定・採用済み） / false（AIレビューで棄却、一覧・検索からは除外）。
-- 既存行はすべて採用済みの記事のため、DEFAULT true でバックフィル不要。

ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_accepted boolean NOT NULL DEFAULT true;

-- 一覧表示側（src/lib/catalog.ts）が false を除外するフィルタで使うため、絞り込みを速くする。
CREATE INDEX IF NOT EXISTS idx_items_ai_accepted ON items (ai_accepted);
