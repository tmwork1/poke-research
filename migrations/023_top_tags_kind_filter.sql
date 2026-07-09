-- migrations/023_top_tags_kind_filter.sql
-- タグクラウード（top_tags RPC、migrations/012）が items.kind を絞り込めず、
-- /papers（kind='paper'）にも /items（kind='article'）のタグが混ざって表示される問題を修正する。
-- item_tags は採用記事（ai_accepted=true）にのみ付与される前提（src/lib/importers/common.ts の
-- syncTags: review.accepted）だが、既存の top_tags 自体がそれ以外の可視条件（link_status 等）を
-- 課していないため、今回も揃えて追加はしない（挙動を変えすぎない）。
--
-- 引数を1個から2個へ増やすため、CREATE OR REPLACE では別シグネチャの関数として並存してしまい、
-- 新しい引数（デフォルト値あり）が既存の1引数呼び出しと曖昧になる（PostgreSQL は
-- 「function is not unique」エラーを返す）。そのため旧シグネチャを明示的に DROP してから
-- 新シグネチャを作成する。呼び出し元（src/lib/catalog.ts）は今回すべて2引数を渡すよう
-- 揃えるため、tag_limit のみの呼び出しは残らない想定。

DROP FUNCTION IF EXISTS top_tags(integer);

CREATE OR REPLACE FUNCTION top_tags(tag_limit integer DEFAULT 20, kind_filter text DEFAULT NULL)
RETURNS TABLE(id integer, name text, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.name, count(*) AS count
  FROM item_tags it
  JOIN tags t ON t.id = it.tag_id
  JOIN items i ON i.id = it.item_id
  WHERE kind_filter IS NULL OR i.kind = kind_filter
  GROUP BY t.id, t.name
  ORDER BY count(*) DESC, t.name ASC
  LIMIT tag_limit;
$$;

-- PostgREST 経由（anon/authenticated/service_role）での rpc 呼び出しを許可する。
-- 旧シグネチャ top_tags(integer) は上記 DROP 済みのため、新シグネチャに対してのみ実行し直す。
GRANT EXECUTE ON FUNCTION top_tags(integer, text) TO PUBLIC;
