-- migrations/005_normalize_tag_diacritics.sql
-- M5 タグ精度の最適化(2巡目): アクセント記号違い（例: pokédex/pokedex、pokéapi/pokeapi）で
-- 同じタグが重複していたため、小文字化に加えて unaccent() でも正規化して統合する。
-- （アプリ側の normalizeTagName も同様にアクセント除去するよう修正済み）

CREATE TEMP TABLE tag_canonical AS
SELECT lower(unaccent(name)) AS lname, min(id) AS keep_id
FROM tags
GROUP BY lower(unaccent(name));

-- 統合先タグを既に持つ item の重複行を先に削除（付け替え時の主キー衝突を避けるため）
DELETE FROM item_tags it
USING tags t, tag_canonical c
WHERE it.tag_id = t.id
  AND t.id <> c.keep_id
  AND lower(unaccent(t.name)) = c.lname
  AND EXISTS (
    SELECT 1 FROM item_tags it2 WHERE it2.item_id = it.item_id AND it2.tag_id = c.keep_id
  );

-- 残りの重複タグ参照を正規タグへ付け替え
UPDATE item_tags it
SET tag_id = c.keep_id
FROM tags t, tag_canonical c
WHERE it.tag_id = t.id
  AND t.id <> c.keep_id
  AND lower(unaccent(t.name)) = c.lname;

-- 重複していた旧タグ行を削除
DELETE FROM tags t
USING tag_canonical c
WHERE lower(unaccent(t.name)) = c.lname AND t.id <> c.keep_id;

-- 残ったタグ名のアクセントを除去（今後の重複防止はアプリ側の normalizeTagName で担保）
UPDATE tags SET name = lower(unaccent(name)) WHERE name <> lower(unaccent(name));

DROP TABLE tag_canonical;
