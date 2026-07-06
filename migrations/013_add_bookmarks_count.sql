-- 人気順ソートの本実装用に、items へブックマーク数のカウンタキャッシュ列を追加する。
-- これまで人気順は「直近300件を取得してJSでソート」する暫定実装で、候補プール外の
-- 記事は人気順に現れなかった。カウンタ列を DB ソートに使うことで全件を対象にする。
-- 整合性は bookmarks の INSERT/DELETE トリガーで維持する（bookmarks は
-- (user_id, item_id) 主キーのため UPDATE は発生しない）。

ALTER TABLE items ADD COLUMN IF NOT EXISTS bookmarks_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION sync_items_bookmarks_count() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookmarks_count ON bookmarks;
CREATE TRIGGER trg_bookmarks_count AFTER INSERT OR DELETE ON bookmarks
  FOR EACH ROW EXECUTE FUNCTION sync_items_bookmarks_count();

-- 既存データとの整合を取る（現時点のブックマーク数で初期化）。
UPDATE items i
SET bookmarks_count = sub.count
FROM (SELECT item_id, count(*)::integer AS count FROM bookmarks GROUP BY item_id) sub
WHERE i.id = sub.item_id;

CREATE INDEX IF NOT EXISTS idx_items_bookmarks_count ON items (bookmarks_count DESC);
