-- migrations/007_add_bookmarks.sql
-- M7: ログインユーザーのお気に入り（ブックマーク）機能

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
