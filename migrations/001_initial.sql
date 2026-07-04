-- migrations/001_initial.sql
-- 初期スキーマ（migrations 用コピー）

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pokemon (
  id serial PRIMARY KEY,
  species text NOT NULL,
  national_id integer,
  nickname text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid REFERENCES research_notes(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  result jsonb,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_research_notes_author ON research_notes(author_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_pokemon ON research_notes(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
