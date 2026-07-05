-- migrations/010_remove_pokemon_tag_nfc.sql
-- 009 では unaccent() で「ポケモン」タグを削除したが、濁点・半濁点が分解された
-- Unicode正規化形（NFD相当）で保存された同名タグ（見た目は同じ「ポケモン」）が
-- unaccent() では一致判定できず残っていたため、normalize(..., NFC) で確実に一致させて削除する。

DELETE FROM tags WHERE normalize(name, NFC) = normalize('ポケモン', NFC);
