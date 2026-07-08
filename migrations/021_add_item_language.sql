-- migrations/021_add_item_language.sql
-- 記事本文の主な言語を記録する列を追加する。AIレビュー（src/lib/importers/article-ai.ts）が
-- 判定した ISO 639-1 の小文字言語コード（ja/en/その他）を保存し、日本語・英語以外の記事を
-- 絞り込み・削除できるようにする。

ALTER TABLE items ADD COLUMN IF NOT EXISTS language text;
CREATE INDEX IF NOT EXISTS idx_items_language ON items(language);
