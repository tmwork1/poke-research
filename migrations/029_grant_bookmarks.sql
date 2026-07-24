-- migrations/029_grant_bookmarks.sql
-- 本番で /repos, /items, /papers アクセス時に
-- {"code":"42501","message":"permission denied for table bookmarks"} が発生（Discord通知）。
-- items/sources等はプロジェクト側のデフォルト権限で動いているが、bookmarks（migrations/007）
-- だけこの権限が本番DB上で欠落していたため、明示的にGRANTする。
-- UPDATEは(user_id, item_id)が主キーのため付与しない（migrations/027参照）。
GRANT SELECT, INSERT, DELETE ON public.bookmarks TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.bookmarks TO service_role;
