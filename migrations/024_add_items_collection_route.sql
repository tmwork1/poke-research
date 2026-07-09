-- migrations/024_add_items_collection_route.sql
-- 事後解析のため、各記事が実際にどの収集ジョブ（経路）で取り込まれたかを記録する列を追加する。
-- sources.type は掲載元プラットフォーム単位（Blog(Brave Search)・はてなブックマーク・RSSフィード
-- 追従の3ジョブはいずれも'blog'）でしか区別できず、どの発見方法で見つかったかは
-- items.metadata->'provenance'->>'source' にしか記録されていなかった（インデックスが無く
-- 集計・絞り込みが煩雑）。この値は全インポーターが挿入時から一貫して設定しているため、
-- 既存データも含めて専用列へ昇格する。

ALTER TABLE items ADD COLUMN IF NOT EXISTS collection_route text;

UPDATE items
SET collection_route = metadata->'provenance'->>'source'
WHERE collection_route IS NULL AND metadata->'provenance'->>'source' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_collection_route ON items (collection_route);
