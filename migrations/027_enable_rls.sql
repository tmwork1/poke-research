-- migrations/027_enable_rls.sql
-- Supabase の「rls_disabled_in_public」指摘（全publicテーブルでRLSが無効）への対応。
-- 書き込み経路は SUPABASE_SECRET_KEY（service_role、常にRLSをバイパスする）へ切り替え済み
-- （src/lib/supabase.ts の getSupabaseAdminClient）。ここでは匿名/authenticatedロールに対する
-- 制限のみを追加する。

-- items/sources/tags/item_tags/annotations: 公開カタログの閲覧に使うため、全行のSELECTのみ
-- 許可する（書き込みポリシーは無し＝匿名/authenticatedからは不可）。ai_accepted/link_status
-- によるフィルタは付けない。詳細ページ（fetchCatalogItemById）やブックマーク一覧は、この条件を
-- 意図的に素通しする既存設計（src/lib/catalog.ts の queryCatalogItems 参照）のため、RLSで一律
-- フィルタすると既存の挙動を壊す。一覧・検索側のフィルタはアプリ側のWHERE句のまま維持する。
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
CREATE POLICY items_public_read ON items FOR SELECT TO public USING (true);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY sources_public_read ON sources FOR SELECT TO public USING (true);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tags_public_read ON tags FOR SELECT TO public USING (true);

ALTER TABLE item_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_tags_public_read ON item_tags FOR SELECT TO public USING (true);

ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY annotations_public_read ON annotations FOR SELECT TO public USING (true);

-- bookmarks: ログインユーザー本人の行のみ読み書きできる。src/lib/bookmarks.ts・
-- src/lib/catalog.ts のブックマーク関連関数は createUserSupabaseClient（authenticatedロール）
-- を使うよう切り替え済み。UPDATEは(user_id, item_id)が主キーのため発生しない。
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY bookmarks_select_own ON bookmarks FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY bookmarks_insert_own ON bookmarks FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY bookmarks_delete_own ON bookmarks FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- users: 本人の行のみ読み書き可能。handle_new_auth_user トリガー（migrations/006）は既に
-- SECURITY DEFINER のためRLSをバイパスして新規行を作成できる。
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON users FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY users_insert_own ON users FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY users_update_own ON users FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- audit_logs/import_runs/feed_subscriptions/ai_prompt_hashes: 内部運用専用テーブル。
-- ポリシーを追加しない（＝匿名/authenticatedからは完全にアクセス不可、service_roleのみ到達）。
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prompt_hashes ENABLE ROW LEVEL SECURITY;

-- bookmark_counts（migrations/012）は全ユーザーのbookmarksを横断集計する公開RPCのため、
-- bookmarksのRLS（本人の行のみ）をまたいで集計できるよう SECURITY DEFINER を付けて再定義する。
CREATE OR REPLACE FUNCTION bookmark_counts(target_item_ids integer[])
RETURNS TABLE(item_id integer, count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.item_id, count(*) AS count
  FROM bookmarks b
  WHERE b.item_id = ANY(target_item_ids)
  GROUP BY b.item_id;
$$;

-- sync_items_bookmarks_count（migrations/013）は bookmarks への INSERT/DELETE トリガーとして
-- items.bookmarks_count を更新するが、items への書き込みポリシーは存在しない（adminのみ）ため、
-- authenticatedロール（ユーザー自身のブックマーク操作）から発火した際にRLSで弾かれないよう
-- SECURITY DEFINER を付けて再定義する。
CREATE OR REPLACE FUNCTION sync_items_bookmarks_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE items SET bookmarks_count = bookmarks_count + 1 WHERE id = NEW.item_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE items SET bookmarks_count = GREATEST(bookmarks_count - 1, 0) WHERE id = OLD.item_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END
$$;
