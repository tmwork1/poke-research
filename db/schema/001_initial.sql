-- 001_initial.sql
-- 初期スキーマ: ローカルSupabase (Postgres) 用
-- 初期スキーマ（ロードマップ準拠: 情報ハブ）

-- 拡張機能
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- users テーブル: 開発者・研究者・アカウント
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

-- sources: データ出典
CREATE TABLE IF NOT EXISTS sources (
  id serial PRIMARY KEY,
  name text NOT NULL,
  type text,
  origin_url text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- items: source から取り込んだレコード（汎用）
CREATE TABLE IF NOT EXISTS items (
  id serial PRIMARY KEY,
  source_id int REFERENCES sources(id) ON DELETE SET NULL,
  external_url text,
  kind text, -- article/library/github/paper/video
  title text,
  authors text[],
  summary text,
  published_at timestamptz,
  updated_at timestamptz,
  metadata jsonb DEFAULT '{}',
  version text,
  created_at timestamptz DEFAULT now(),
  search_vector tsvector
);

-- tags と中間テーブル
CREATE TABLE IF NOT EXISTS tags (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  tag_id int REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

-- annotations: Item に付与される注釈 + provenance
CREATE TABLE IF NOT EXISTS annotations (
  id serial PRIMARY KEY,
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text,
  value jsonb,
  provenance jsonb,
  created_at timestamptz DEFAULT now()
);

-- item_relations: アイテム同士の関連を表す知識グラフ用テーブル
CREATE TABLE IF NOT EXISTS item_relations (
  from_item_id int REFERENCES items(id) ON DELETE CASCADE,
  to_item_id int REFERENCES items(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  provenance jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (from_item_id, to_item_id, relation_type)
);

-- 検索用関数とトリガ
CREATE OR REPLACE FUNCTION update_items_search_vector() RETURNS trigger AS $$
BEGIN
  -- search based on title + summary
  NEW.search_vector := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.summary, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_search BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION update_items_search_vector();

-- インデックス
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_search ON items USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_from ON item_relations(from_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_to ON item_relations(to_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_type ON item_relations(relation_type);
-- experiments omitted: not required for information hub
