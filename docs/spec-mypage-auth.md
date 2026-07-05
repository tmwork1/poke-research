# 仕様: Googleログイン（Supabase Auth）とマイページ

このドキュメントは、一般ユーザー向けの Google ログインと、ログイン後に使える「マイページ（お気に入り機能）」の仕様をまとめたものである。実装前の設計合意として作成し、実装時はこの内容に従う。

## 背景・スコープ

- 現状の認証は管理者専用の Basic 認証（`src/lib/auth.ts` / `src/middleware.ts`、`.env` の `ADMIN_USERNAME`/`ADMIN_PASSWORD`）のみで、一般ユーザー向けのログインは存在しない。
- 今回追加するのは一般ユーザー向けの Google ログイン（Supabase Auth 経由）と、ログイン後にアクセスできる `/mypage`。
- マイページの中身は **お気に入り（ブックマーク）機能** に限定する。プロフィール表示、注釈履歴、投稿履歴などは今回のスコープ外。
- ログインユーザーに許可する書き込みは **自分のお気に入りの追加・削除のみ**。items / sources / annotations の編集権限は変更せず、引き続き管理者Basic認証のみが行える。
- この機能は既存ロードマップ（M1〜M6）に含まれていなかった新規機能のため、`docs/development-roadmap.md` に M7 として追記する。
- 実装はM6（デプロイ・リリース準備）完了後、本番環境（Supabaseのホスト済みプロジェクト）を対象に行う。Google OAuthのリダイレクトURIは本番ドメインで一度だけ設定すればよく、ローカルSupabase CLIスタック（`supabase start`）を別途立てての事前検証は行わない。

## 1. Supabase Auth 側の設定

- Supabase ダッシュボードで Google プロバイダを有効化する。
- Google Cloud Console で OAuth クライアントを作成し、リダイレクトURIに Supabase の `https://<project>.supabase.co/auth/v1/callback` を登録する。
- Google の Client ID / Secret は Supabase 側の設定のみで完結し、アプリの `.env` には追加不要。

## 2. ログインフロー（新規 API ルート）

- `GET /api/auth/login`
  `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: \`${siteUrl}/api/auth/callback\` } })` の結果URLへリダイレクトする。
- `GET /api/auth/callback`
  受け取った `code` を `exchangeCodeForSession` でセッションに交換し、Cookie に保存後 `/mypage` へリダイレクトする。
- `POST /api/auth/logout`
  セッションを破棄し Cookie を削除、トップページへリダイレクトする。

Cloudflare Workers 環境では `localStorage` が使えないため、Cookie ベースのセッション永続化が必要。`@supabase/ssr` を新規依存として追加し、Cookie 経由のセッション読み書きに利用する。既存の `src/lib/supabase.ts`（anon key のみのステートレスクライアント）とは別に、ユーザーセッション用のクライアント生成処理を用意する。

## 3. `users` テーブルの扱い

既存の `public.users`（`id uuid` / `email` / `display_name`、`annotations.author_id` から参照される）をそのまま活かし、Supabase Auth の `auth.users` と紐付ける。

新規マイグレーション（`006_link_users_to_auth.sql` 想定）:

- `public.users.id` を `auth.users(id)` への参照に変更する（同一 uuid を共有し、`gen_random_uuid()` による独自採番はやめる）。
- `auth.users` への INSERT 時に `public.users` へ自動反映するトリガーを追加する（`display_name` は Google プロフィールの `raw_user_meta_data->>'full_name'` などから取得）。
- 既存の管理者Basic認証（`actor` は文字列のusername）とは無関係のまま維持し、混同しない。

## 4. 新規テーブル: `bookmarks`

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  item_id int REFERENCES items(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
```

## 5. API

- `GET /api/bookmarks` — ログイン中ユーザー自身のブックマークを item 情報付きで返す。
- `POST /api/bookmarks` — `{ itemId }` を受け取り、自分の行として追加する。
- `DELETE /api/bookmarks/:itemId` — 自分の行を削除する。

いずれも `user_id = locals.user.id` を API 側で強制し、他ユーザーのデータには触れさせない。

### 既存ミドルウェアへの変更点（要注意）

`src/middleware.ts` の `requiresAuth()` は現在「`/api/**` への書き込み系メソッドは無条件に管理者Basic認証必須」という判定になっている。`/api/bookmarks` と `/api/auth/**` はこの対象から除外し、代わりに「`locals.user` が存在すること」を要求する別チェックを追加する。管理者認証とユーザーセッション認証は別レーンとして扱い、既存の管理者向け書き込み保護ロジックには手を入れない。

## 6. 画面

- `/mypage`
  - 未ログイン時: ログインボタン（`/api/auth/login` へのリンク）のみのミニマルな画面。
  - ログイン時: 表示名・メールアドレス・ログアウトボタンと、お気に入り一覧（`ItemCard.astro` を再利用）を表示する。
- 既存の `ItemCard.astro` にお気に入りトグル（アイコンボタン。色付きバッジ等の装飾は使わない）を追加し、カタログ・検索結果一覧でも同じボタンを表示する。未ログイン時にクリックされた場合はログイン導線（`/api/auth/login`）に飛ばす。

## 7. 権限モデルまとめ

- items / sources / annotations の編集権限は変更なし（管理者Basic認証のみ）。
- Google ログインユーザーの書き込みは「自分のお気に入りの追加・削除」のみ。
- RLS は導入しない。既存アーキテクチャ（Supabase クライアントは anon key のみ、認可はアプリ層＝Astro middleware / API route で行う）を踏襲する。

## 8. 未実装事項（このドキュメントは設計のみ）

- マイグレーション `006_link_users_to_auth.sql` / `007_add_bookmarks.sql`（ファイル名は実装時に確定）
- `@supabase/ssr` の導入
- `src/lib/auth.ts` 相当のユーザーセッション読み取り処理
- `src/middleware.ts` の `requiresAuth()` 拡張
- `/api/auth/*`, `/api/bookmarks*` の実装
- `/mypage` ページと `ItemCard.astro` へのお気に入りボタン追加
