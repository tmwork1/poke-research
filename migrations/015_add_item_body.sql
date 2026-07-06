-- migrations/015_add_item_body.sql
-- これまで本文ハッシュ(version)計算のためだけに取得し破棄していた本文テキストを保存し、
-- 検索対象を title/summary から本文まで広げられるようにする。行肥大化を避けるため、
-- インポーター側で妥当な長さ（約2万字）に切り詰めてから書き込む前提の列とする。
-- 既存アイテムへの遡及バックフィルは別途判断（収集元APIへの再取得が必要なため）。

ALTER TABLE items ADD COLUMN IF NOT EXISTS body text;

CREATE INDEX IF NOT EXISTS idx_items_body_trgm ON items USING GIN (body gin_trgm_ops);
