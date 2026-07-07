-- migrations/020_add_tag_monthly_counts.sql
-- ホームの「上位タグの記事数推移」グラフ用の月次集計 RPC。
-- top_tags（migrations/012）と同じ母集団（item_tags 全体、link_status/ai_accepted による
-- フィルタなし）を月単位で数え、タグクラウドに表示される合計件数と食い違わないようにする。

CREATE OR REPLACE FUNCTION tag_monthly_counts(target_tag_ids integer[], months_back integer DEFAULT 6)
RETURNS TABLE(tag_id integer, month date, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT
    it.tag_id,
    date_trunc('month', COALESCE(i.published_at, i.created_at))::date AS month,
    count(*) AS count
  FROM item_tags it
  JOIN items i ON i.id = it.item_id
  WHERE it.tag_id = ANY(target_tag_ids)
    AND COALESCE(i.published_at, i.created_at) >= date_trunc('month', now()) - ((months_back - 1) * interval '1 month')
  GROUP BY it.tag_id, month
  ORDER BY it.tag_id, month;
$$;

GRANT EXECUTE ON FUNCTION tag_monthly_counts(integer[], integer) TO PUBLIC;
