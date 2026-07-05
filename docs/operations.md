# 運用メモ

単一管理者運用を前提に、デプロイ・バックアップ／復旧・障害時の初動をまとめる。日々の開発手順（環境変数、収集ジョブ、監査ログなど）は [README](../README.md) を参照する。

## CI（GitHub Actions）

`.github/workflows/ci.yml` が `main` への push と pull request で以下を自動検証する。

- **build**: `npm ci` + `npm run build`（Astro のビルドと型チェック）。
- **migrations**: CI ジョブ内で使い捨ての `postgres:16` コンテナを起動し、`migrations/*.sql` を空のスキーマへ最初から順に適用できるか（`npm run migrate`）を検証する。本番 Supabase の資格情報は CI に置かない。

本番 Supabase に対する実際の適用（`npm run migrate` を `DATABASE_URL` に本番接続文字列を渡して実行）と、`scripts/db/test-db.mjs` による CRUD スモークテストは、デプロイ時に手動で行う（下記「デプロイ手順」参照）。CI が緑でも、本番への `migrate` 実行と目視確認は別途必要。

## デプロイ手順

前提: Cloudflare Workers（`pokemon-research`）は GitHub の `main` ブランチと連携済みで、push（PR の merge を含む）で自動ビルド・デプロイされる。手元での作業は、自動デプロイの対象外である本番 Supabase 側の対応のみ。

1. `migrations/` に新しいマイグレーションファイルがあるか確認する。
2. スキーマを変更した場合のみ、`scripts/db/test-db.mjs` を本番の `SUPABASE_URL` / `SUPABASE_SECRET_KEY` で実行し、CRUD が成功することを確認する（テストデータは自動で削除される）。
3. 不足しているシークレットがないか確認する（`.env.example` 参照、`wrangler secret put <NAME>` で設定）。
4. `npm run release` を実行し、未適用のマイグレーションを適用する。`.env` の `DATABASE_URL`（本番接続文字列）を自動で参照する。`main` への push 前に済ませる。
   ```bash
   npm run release
   ```
5. `main` へ push / merge する。ビルド状況は Cloudflare ダッシュボードの **Workers & Pages → pokemon-research → Deployments** で確認できる。
6. デプロイ後、本番 URL（https://poke-research.com/）の閲覧系エンドポイント（`GET /api/items` など）と Basic 認証付きの書き込み系エンドポイントを一度叩いて動作確認する。

`npm run deploy`（`wrangler deploy`）は、Cloudflare 連携が使えない緊急時や `main` を経由しない検証用の手動デプロイ手段として残している。

## バックアップと復旧

自前のバックアップ処理は実装しない。Supabase プロジェクトが提供する標準バックアップ機能に依拠する。

### 前提

- Supabase の自動バックアップの有無・保存期間・Point-in-Time Recovery（PITR）の対応はプロジェクトのプラン（Free / Pro / Team 等）に依存する。現在契約しているプランのバックアップ設定を Supabase ダッシュボードの **Database → Backups** で確認しておく。
- PITR が使えないプラン・保存期間外の場合、直近の自動バックアップ以降の変更（収集ジョブが取り込んだ記事など）は復旧時に失われる。取り込みは冪等（`external_url` の UNIQUE 制約による upsert）なので、データ欠落時は該当期間の cron 実行を再度手動で走らせれば再取得できる場合がある（note/Zenn/Qiita とも記事が削除・非公開化されていない限り）。

### 復旧手順

1. Supabase ダッシュボードの **Database → Backups** から、復旧したい時点のバックアップ（または PITR の場合は復旧したい時刻）を選ぶ。
2. ダッシュボードの復元フローに従って復元を実行する（既存プロジェクトへの復元か、新規プロジェクトへの復元かはダッシュボードの選択肢に従う。新規プロジェクトに復元した場合は `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` / `DATABASE_URL` を新しい接続情報に差し替える）。
3. 復元後、`npm run migrate` を実行し、バックアップ時点より後に追加されたマイグレーションを適用する（`migrations` テーブルに記録が残っているため、未適用分だけが実行される）。
4. `scripts/db/test-db.mjs` で CRUD が正常に動くことを確認する。
5. `GET /api/audit` で復元直前の操作履歴を確認し、復元後に再実行が必要な書き込み（収集ジョブなど）がないか判断する。
6. 復元先が新規 Supabase プロジェクトの場合、`wrangler secret put` で本番の Cloudflare Workers 環境変数を新しい接続情報に更新する（シークレット更新は再デプロイなしで反映される）。

## 障害対応の初動

- 収集ジョブ（Qiita/Zenn/note）の失敗は `wrangler tail` または Cloudflare ダッシュボードのログで `[cron:qiita|zenn|note] sync failed` を確認する。記事単位の失敗は自動で `skipped` に吸収されるため、ここに出るのは外部 API 全断や Supabase 未接続などの致命的なケースのみ（詳細は README の各収集ジョブの節を参照）。
- API 全体が 500 を返す場合は、まず `SUPABASE_URL` / `SUPABASE_SECRET_KEY` などのシークレットが Cloudflare Workers 側で失効・変更されていないかを確認する。
- 管理者操作（書き込み系 API）が 401 になる場合は `ADMIN_USERNAME` / `ADMIN_PASSWORD` の設定を確認する。
