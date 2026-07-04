# DBスキーマ案（ローカルSupabase向け）

このファイルはローカルで立ち上げたSupabase/Postgresに適用する初期スキーマの説明と実行手順を示します。

ファイル: `db/schema/001_initial.sql`

概要:
- `users`: アカウント／研究者情報
- `pokemon`: 収集・参照するポケモン基本情報
- `research_notes`: 研究ノート、メモ
- `experiments`: 実験ログ（設定／結果を JSONB で保存）

ローカルでの適用手順例:

1. Supabase コンテナ／サービスが起動していることを確認

2. `psql` または `supabase` CLI で SQL を実行

```powershell
# psql を使う例
psql "postgresql://postgres:postgres@localhost:5432/postgres" -f db/schema/001_initial.sql

# supabase CLI を使う例（ログイン済み・ローカルプロジェクト設定済みの場合）
supabase db remote set "postgresql://postgres:postgres@localhost:5432/postgres"
supabase db query < db/schema/001_initial.sql
```

注意点:
- `pgcrypto` の `gen_random_uuid()` を使用します。拡張が有効でない場合は SQL の先頭で `CREATE EXTENSION IF NOT EXISTS pgcrypto;` を実行します。
- マイグレーションを運用する場合は `migrations/` ディレクトリに分割して管理してください。

次のステップ:
- ローカルSupabase接続設定をプロジェクトに追加（`.env.example` と設定読み込みラッパー）
- DBクライアントラッパー実装（`src/lib/db` など）
