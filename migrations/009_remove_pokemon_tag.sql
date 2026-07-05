-- migrations/009_remove_pokemon_tag.sql
-- 「ポケモン」タグはこのハブの全記事に当たり前に付くため情報価値がなく削除する。
-- （今後もAI採点プロンプト側で生成しないようにする: src/lib/importers/article-ai.ts）

DELETE FROM tags WHERE lower(unaccent(name)) = lower(unaccent('ポケモン'));
