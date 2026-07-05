# 運用メモ

単一管理者運用を前提に、デプロイ・バックアップ／復旧・障害時の初動をまとめる。日々の開発手順（環境変数、収集ジョブ、監査ログなど）は [README](../README.md) を参照する。

## CI（GitHub Actions）

`.github/workflows/ci.yml` が `master` への push と pull request で以下を自動検証する。

- **build**: `npm ci` + `npm run build`（Astro のビルドと型チェック）。
- **migrations**: CI ジョブ内で使い捨ての `postgres:16` コンテナを起動し、`migrations/*.sql` を空のスキーマへ最初から順に適用できるか（`npm run migrate`）を検証する。本番 Supabase の資格情報は CI に置かない。

本番 Supabase に対する実際の適用（`npm run migrate` を `DATABASE_URL` に本番接続文字列を渡して実行）と、`scripts/db/test-db.mjs` による CRUD スモークテストは、デプロイ時に手動で行う（下記「デプロイ手順」参照）。CI が緑でも、本番への `migrate` 実行と目視確認は別途必要。

## デプロイ手順（手動）

デプロイは CI/CD に含めず、管理者が手元から実行する。

1. `master` の変更を確認し、必要なら新しいマイグレーションファイルが `migrations/` に追加されているか確認する。
2. 本番 Supabase の `DATABASE_URL` を使って `npm run migrate` を実行し、未適用のマイグレーションを本番に適用する。
3. 新しいテーブル・カラムを追加した場合は `scripts/db/test-db.mjs` を本番の `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` で実行し、書き込み・削除が成功することを確認する（テストデータは自動で削除される）。
4. `wrangler secret put <NAME>` で不足しているシークレット（`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `OPENAI_API_KEY` / `OPENAI_MODEL` など、`.env.example` 参照）が設定済みか確認する。
5. `npm run deploy`（`astro build && wrangler deploy`）で本番へ反映する。
6. デプロイ後、`GET /api/items` など閲覧系エンドポイントと、Basic 認証付きの書き込み系エンドポイントを一度叩いて動作確認する。Cron ジョブ（Qiita/Zenn/note の収集）は次回の定期実行を待つか、`POST /api/import/qiita` 等を手動で叩いて確認する。

## バックアップと復旧

自前のバックアップ処理は実装しない。Supabase プロジェクトが提供する標準バックアップ機能に依拠する。

### 前提

- Supabase の自動バックアップの有無・保存期間・Point-in-Time Recovery（PITR）の対応はプロジェクトのプラン（Free / Pro / Team 等）に依存する。現在契約しているプランのバックアップ設定を Supabase ダッシュボードの **Database → Backups** で確認しておく。
- PITR が使えないプラン・保存期間外の場合、直近の自動バックアップ以降の変更（収集ジョブが取り込んだ記事など）は復旧時に失われる。取り込みは冪等（`external_url` の UNIQUE 制約による upsert）なので、データ欠落時は該当期間の cron 実行を再度手動で走らせれば再取得できる場合がある（note/Zenn/Qiita とも記事が削除・非公開化されていない限り）。

### 復旧手順

1. Supabase ダッシュボードの **Database → Backups** から、復旧したい時点のバックアップ（または PITR の場合は復旧したい時刻）を選ぶ。
2. ダッシュボードの復元フローに従って復元を実行する（既存プロジェクトへの復元か、新規プロジェクトへの復元かはダッシュボードの選択肢に従う。新規プロジェクトに復元した場合は `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` / `DATABASE_URL` を新しい接続情報に差し替える）。
3. 復元後、`npm run migrate` を実行し、バックアップ時点より後に追加されたマイグレーションを適用する（`migrations` テーブルに記録が残っているため、未適用分だけが実行される）。
4. `scripts/db/test-db.mjs` で CRUD が正常に動くことを確認する。
5. `GET /api/audit` で復元直前の操作履歴を確認し、復元後に再実行が必要な書き込み（収集ジョブなど）がないか判断する。
6. 復元先が新規 Supabase プロジェクトの場合、`wrangler secret put` で本番の Cloudflare Workers 環境変数を新しい接続情報に更新してから再デプロイする。

## 障害対応の初動

- 収集ジョブ（Qiita/Zenn/note）の失敗は `wrangler tail` または Cloudflare ダッシュボードのログで `[cron:qiita|zenn|note] sync failed` を確認する。記事単位の失敗は自動で `skipped` に吸収されるため、ここに出るのは外部 API 全断や Supabase 未接続などの致命的なケースのみ（詳細は README の各収集ジョブの節を参照）。
- API 全体が 500 を返す場合は、まず `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` などのシークレットが Cloudflare Workers 側で失効・変更されていないかを確認する。
- 管理者操作（書き込み系 API）が 401 になる場合は `ADMIN_USERNAME` / `ADMIN_PASSWORD` の設定を確認する。
