-- migrations/016_add_link_status.sql
-- 元記事の削除・非公開化を検出する仕組みが無く、リンク切れになったアイテムが一覧に
-- 残り続けていた。cron で external_url を定期チェックし、結果を items に記録する列を
-- 追加する（詳細は src/lib/link-check.ts）。
-- link_status: 'ok'（既定・未チェックの既存行も含む） / 'broken'（直近チェックで404/410等を検出）。
-- link_checked_at: 直近チェック時刻（未チェックなら null のまま）。
-- link_broken_since: 初めて broken を検出した時刻。ok に戻ったら null へ戻す
-- （一時的な障害と恒久的な削除を区別できるよう、連続して broken 判定が出た場合のみ
-- link_status を broken に倒す運用は checker 側のロジックで担保する）。

ALTER TABLE items ADD COLUMN IF NOT EXISTS link_status text NOT NULL DEFAULT 'ok';
ALTER TABLE items ADD COLUMN IF NOT EXISTS link_checked_at timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS link_broken_since timestamptz;

-- 一覧表示側（src/lib/catalog.ts）が broken を除外するフィルタで使うため、絞り込みを速くする。
CREATE INDEX IF NOT EXISTS idx_items_link_status ON items (link_status);
