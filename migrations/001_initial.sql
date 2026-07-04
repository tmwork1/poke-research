-- migrations/001_initial.sql
-- 初期スキーマ（migrations 用コピー）

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id serial PRIMARY KEY,
  name text NOT NULL,
  type text,
  origin_url text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id serial PRIMARY KEY,
  source_id int REFERENCES sources(id) ON DELETE SET NULL,
  external_url text,
  kind text,
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

CREATE TABLE IF NOT EXISTS tags (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  tag_id int REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS item_relations (
  from_item_id int REFERENCES items(id) ON DELETE CASCADE,
  to_item_id int REFERENCES items(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  provenance jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (from_item_id, to_item_id, relation_type)
);

CREATE TABLE IF NOT EXISTS annotations (
  id serial PRIMARY KEY,
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text,
  value jsonb,
  provenance jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_items_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.summary, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_search BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION update_items_search_vector();

CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_search ON items USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_from ON item_relations(from_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_to ON item_relations(to_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_type ON item_relations(relation_type);
