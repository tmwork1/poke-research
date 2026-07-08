-- migrations/022_add_feed_subscriptions.sql
-- Brave Search / はてなブックマーク検索経由で発見し AI レビューに採用された記事のうち、
-- 記事ページが RSS/Atom フィードを配信している場合にそのフィードURLを登録する。
-- 以後は feed.ts がこのテーブルの active な行を直接ポーリングし、同じ発信元をキーワード検索
-- で探し直さずに追従できるようにする（Brave 無料枠の消費削減・誤検出の削減が狙い）。

CREATE TABLE IF NOT EXISTS feed_subscriptions (
  id serial PRIMARY KEY,
  feed_url text UNIQUE NOT NULL,
  hostname text NOT NULL,
  discovered_from_url text,
  status text NOT NULL DEFAULT 'active',
  consecutive_failures int NOT NULL DEFAULT 0,
  last_fetched_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_subscriptions_status ON feed_subscriptions(status);
