-- migrations/017_drop_item_relations.sql
-- item_relations は「知識グラフ用」として用意したが、実際には
-- scripts/db/detect-duplicate-items.mjs の検出結果置き場としてしか使われず、
-- それを読んで表示・解決する機能も作られなかった（関連記事表示はタグ重複ベースの
-- ヒューリスティックで別実装済み）。未運用のまま残すより削除する。

DROP TABLE IF EXISTS item_relations;
