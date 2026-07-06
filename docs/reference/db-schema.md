# DBスキーマ案

このファイルは、ローカルで立ち上げた Supabase / Postgres に適用する初期スキーマの説明と実行手順をまとめたものです。

対象ファイル: [db/schema/001_initial.sql](db/schema/001_initial.sql)

## 目的

このプロジェクトは、ポケモンプログラミングに関する技術情報を集約する情報ハブです。

対戦用の個体情報やパーティ情報は持たず、記事・ライブラリ・GitHub リポジトリ・論文・動画のような外部コンテンツを中心に扱います。

## 主なテーブル

- `users`: アカウント、研究者、投稿者情報
- `sources`: 情報の取得元。Qiita、Zenn、GitHub、RSS など
- `items`: 記事、ライブラリ、GitHub リポジトリ、論文、動画を横断管理する中核テーブル
- `tags`: 分類用タグのマスターテーブル
- `item_tags`: `items` と `tags` を結びつける中間テーブル
- `annotations`: AI 要約や補足メタデータなどの注釈

## 設計方針

- `items` は種類ごとに分けすぎず、共通項目を持つ汎用テーブルとして扱う
- 種別の差分は `kind` と `metadata` で表現する
- タグ名そのものは `tags` に集約し、各アイテムへの付与は `item_tags` で表現する
- AI 要約や分類結果は `annotations` に寄せ、元データと分離する

## 補足

本プロジェクトでは、ポケモン個体情報、実験ログ、内部メモは扱いません。必要な情報だけを集めて、検索・要約・関連付けに集中する構成にしています。

## 適用手順

1. Supabase コンテナまたはサービスが起動していることを確認する
2. `psql` か Supabase CLI で SQL を流し込む

```powershell
# psql を使う例
psql "postgresql://postgres:postgres@localhost:54322/postgres" -f db/schema/001_initial.sql

# supabase CLI を使う例
supabase db remote set "postgresql://postgres:postgres@localhost:54322/postgres"
supabase db query < db/schema/001_initial.sql
```

## 注意点

- `pgcrypto` の `gen_random_uuid()` を使うため、拡張が有効であることを確認する
- 変更を継続運用する場合は、`migrations/` 側でも同じ構造を維持する

## 次の作業候補

- `.env.example` と Supabase 接続設定の整備
