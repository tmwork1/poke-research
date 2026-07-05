-- migrations/011_add_tag_display_name.sql
-- タグの元表記（大文字小文字など）を保持する display_name 列を追加する。
-- src/lib/importers/common.ts の ensureTags が新規タグ作成時にこの列へ書き込む実装が
-- 先行してマージされていたが、対応する列がなく挿入時にエラーになっていたため追加する。

ALTER TABLE tags ADD COLUMN IF NOT EXISTS display_name text;
