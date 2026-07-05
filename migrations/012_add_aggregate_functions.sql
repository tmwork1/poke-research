-- タグ使用回数とブックマーク数の集計を DB 側（RPC）へ寄せる。
-- これまで src/lib/catalog.ts / src/lib/importers/common.ts が item_tags・bookmarks の
-- 対象行を全取得して JS で集計しており、アイテム増加に対して線形に悪化するため、
-- GROUP BY を PostgREST から呼べる関数として用意する。

CREATE OR REPLACE FUNCTION top_tags(tag_limit integer DEFAULT 20)
RETURNS TABLE(id integer, name text, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.name, count(*) AS count
  FROM item_tags it
  JOIN tags t ON t.id = it.tag_id
  GROUP BY t.id, t.name
  ORDER BY count(*) DESC, t.name ASC
  LIMIT tag_limit;
$$;

CREATE OR REPLACE FUNCTION bookmark_counts(target_item_ids integer[])
RETURNS TABLE(item_id integer, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT b.item_id, count(*) AS count
  FROM bookmarks b
  WHERE b.item_id = ANY(target_item_ids)
  GROUP BY b.item_id;
$$;

-- PostgREST 経由（anon/authenticated/service_role）での rpc 呼び出しを許可する。
GRANT EXECUTE ON FUNCTION top_tags(integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION bookmark_counts(integer[]) TO PUBLIC;
