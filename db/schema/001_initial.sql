-- 001_initial.sql
-- 初期スキーマ: ローカルSupabase (Postgres) 用

-- 拡張機能
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- users テーブル: 開発者・研究者・アカウント
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

-- pokemon テーブル: 収集したポケモンの基本情報
CREATE TABLE IF NOT EXISTS pokemon (
  id serial PRIMARY KEY,
  species text NOT NULL,
  national_id integer,
  nickname text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- research_notes テーブル: 研究ノートやメモ
CREATE TABLE IF NOT EXISTS research_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  pokemon_id integer REFERENCES pokemon(id) ON DELETE SET NULL,
  title text NOT NULL,
  content text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- experiments テーブル: 実験実行ログ
CREATE TABLE IF NOT EXISTS experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid REFERENCES research_notes(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  result jsonb,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  finished_at timestamptz
);

-- 基本インデックス
CREATE INDEX IF NOT EXISTS idx_research_notes_author ON research_notes(author_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_pokemon ON research_notes(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
