-- migrations/002_add_unique_constraints.sql
-- Qiita インポートの select→insert/update に潜む TOCTOU レースを防ぐため、
-- upsert の対象カラムに UNIQUE 制約を追加する。

ALTER TABLE sources ADD CONSTRAINT sources_origin_url_key UNIQUE (origin_url);
ALTER TABLE items ADD CONSTRAINT items_external_url_key UNIQUE (external_url);
