-- migrations/019_add_source_item_counts.sql
-- 検索ページのソース絞り込みボタンに件数を表示し、多い順に並べ替えるための集計 RPC。
-- migrations/012 の top_tags と同じ考え方で、一覧表示側（src/lib/catalog.ts の
-- queryCatalogItems）が適用する可視条件（link_status != 'broken' AND ai_accepted）と
-- 揃えることで、絞り込み結果の件数とこの集計値が一致するようにする。

CREATE OR REPLACE FUNCTION source_item_counts()
RETURNS TABLE(source_id integer, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT i.source_id, count(*) AS count
  FROM items i
  WHERE i.source_id IS NOT NULL
    AND i.link_status != 'broken'
    AND i.ai_accepted = true
  GROUP BY i.source_id;
$$;

GRANT EXECUTE ON FUNCTION source_item_counts() TO PUBLIC;
