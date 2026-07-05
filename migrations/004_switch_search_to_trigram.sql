-- migrations/004_switch_search_to_trigram.sql
-- M5: 実データ検証で、日本語の全文検索が 'simple' tsvector では機能していないことが判明した。
-- to_tsvector('simple', ...) は分かち書きされていないCJK文を1トークンとして扱ってしまい、
-- 「ポケモン」で検索しても72件中3件しかヒットしないなど、検索が実質壊れていたため、
-- 文字n-gramベースで日本語にも効く pg_trgm による部分一致検索に切り替える。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TRIGGER IF EXISTS trg_items_search ON items;
DROP FUNCTION IF EXISTS update_items_search_vector();
DROP INDEX IF EXISTS idx_items_search;
ALTER TABLE items DROP COLUMN IF EXISTS search_vector;

CREATE INDEX IF NOT EXISTS idx_items_title_trgm ON items USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_summary_trgm ON items USING GIN (summary gin_trgm_ops);

-- タグ名の大文字小文字ゆれ（例: AI/ai、Python/python）で同じタグが重複していたため、
-- 小文字を正規とみなして統合する。
CREATE TEMP TABLE tag_canonical AS
SELECT lower(name) AS lname, min(id) AS keep_id
FROM tags
GROUP BY lower(name);

-- 統合先タグを既に持つ item の重複行を先に削除（付け替え時の主キー衝突を避けるため）
DELETE FROM item_tags it
USING tags t, tag_canonical c
WHERE it.tag_id = t.id
  AND t.id <> c.keep_id
  AND lower(t.name) = c.lname
  AND EXISTS (
    SELECT 1 FROM item_tags it2 WHERE it2.item_id = it.item_id AND it2.tag_id = c.keep_id
  );

-- 残りの重複タグ参照を正規タグへ付け替え
UPDATE item_tags it
SET tag_id = c.keep_id
FROM tags t, tag_canonical c
WHERE it.tag_id = t.id
  AND t.id <> c.keep_id
  AND lower(t.name) = c.lname;

-- 重複していた旧タグ行を削除
DELETE FROM tags t
USING tag_canonical c
WHERE lower(t.name) = c.lname AND t.id <> c.keep_id;

-- 残ったタグ名を小文字に統一（今後の重複防止はアプリ側の normalizeTagName で担保）
UPDATE tags SET name = lower(name) WHERE name <> lower(name);

DROP TABLE tag_canonical;
