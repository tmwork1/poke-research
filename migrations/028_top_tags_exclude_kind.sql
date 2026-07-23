-- migrations/028_top_tags_exclude_kind.sql
-- ホームタブでGitHubリポジトリ(kind='repo')を一覧から除外するのに合わせ、タグクラウードにも
-- repo専用タグが混ざらないよう、top_tags RPC（migrations/012、023でkind_filter追加）に
-- exclude_kind引数を追加する。023と同じ理由（引数追加はCREATE OR REPLACEでは別シグネチャ扱いに
-- なり呼び出しが曖昧になる）で、旧シグネチャを明示的にDROPしてから新シグネチャを作成する。

DROP FUNCTION IF EXISTS top_tags(integer, text);

CREATE OR REPLACE FUNCTION top_tags(tag_limit integer DEFAULT 20, kind_filter text DEFAULT NULL, exclude_kind text DEFAULT NULL)
RETURNS TABLE(id integer, name text, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.name, count(*) AS count
  FROM item_tags it
  JOIN tags t ON t.id = it.tag_id
  JOIN items i ON i.id = it.item_id
  WHERE (kind_filter IS NULL OR i.kind = kind_filter)
    AND (exclude_kind IS NULL OR i.kind <> exclude_kind)
  GROUP BY t.id, t.name
  ORDER BY count(*) DESC, t.name ASC
  LIMIT tag_limit;
$$;

-- PostgREST 経由（anon/authenticated/service_role）での rpc 呼び出しを許可する。
-- 旧シグネチャ top_tags(integer, text) は上記 DROP 済みのため、新シグネチャに対してのみ実行し直す。
GRANT EXECUTE ON FUNCTION top_tags(integer, text, text) TO PUBLIC;
