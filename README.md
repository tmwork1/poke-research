# poke-research

ポケモンプログラミング情報を収集・整理・検索する Astro + Supabase + Cloudflare ベースの情報ハブ。

公開URL: https://poke-research.com/

## Project Structure

```text
/
├── migrations/                  # Supabase (Postgres) 用マイグレーション
├── scripts/
│   ├── db/                      # マイグレーション適用・CRUD スモークテスト
│   └── eval/                    # 収集/検索/フィルタ/タグ精度の評価スクリプト（試行→評価→修正）
├── src
│   ├── components/               # CatalogPage / ItemCard など
│   ├── layouts/Layout.astro
│   ├── lib/
│   │   ├── importers/            # Qiita / Zenn / note 収集 + AI レビュー
│   │   ├── catalog.ts             # 検索・フィルタ条件の組み立て
│   │   ├── db.ts                   # 共通 CRUD ヘルパー（監査ログ連携）
│   │   └── auth.ts                 # Basic 認証
│   ├── middleware.ts               # 書き込み系 API の認証
│   ├── pages/
│   │   ├── api/                    # items / sources / tags / annotations / audit / import / export
│   │   └── index.astro / search.astro / items/
│   └── worker.ts                   # Cloudflare Cron Triggers のエントリポイント
└── wrangler.jsonc
```

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).

## Environment variables

1. Copy `.env.example` to `.env` and fill in your local Supabase keys, API key, and model name (do not commit `.env`).

```powershell
cp .env.example .env
# then edit .env to add real keys and model
```

2. If you accidentally committed secrets into the repository, rotate those keys in Supabase and remove them from the repo history.

## CI

`main` への push と pull request で GitHub Actions（`.github/workflows/ci.yml`）が以下を自動検証する。

- `npm run build`（Astro のビルドと型チェック）
- 使い捨ての Postgres コンテナに対する `migrations/*.sql` の適用（本番 Supabase の資格情報は CI に置かない）

本番へのデプロイ手順、バックアップ・復旧手順、障害対応の初動は [docs/reference/operations.md](docs/reference/operations.md) を参照する。Cloudflare Workers は GitHub の `main` ブランチと連携済みで、push（merge を含む）で自動ビルド・デプロイされる。本番 Supabase へのマイグレーション適用（`npm run release`）は自動デプロイの対象外のため、引き続き手動で行う。

## アクセス制御（管理者操作の Basic 認証）

- 想定ユーザーは「単一管理者 + 公開読み取り」。カタログの閲覧系 API（`/api/items` `/api/sources` `/api/tags` `/api/annotations` の GET、`/api/export/items.csv`）は認証不要で公開する。
- 書き込み系（items/sources/annotations の POST/PUT/PATCH/DELETE、`/api/import/*` の手動起動）と `/api/audit`（GET を含め常時）は `src/middleware.ts` の Basic 認証で保護される。
- 資格情報は `.env` の `ADMIN_USERNAME` / `ADMIN_PASSWORD`（ローカルの `wrangler dev` は `.dev.vars`）で設定する。本番では `wrangler secret put ADMIN_USERNAME` / `wrangler secret put ADMIN_PASSWORD` を使う。
- 呼び出し例: `curl -u <ADMIN_USERNAME>:<ADMIN_PASSWORD> -X POST http://localhost:4321/api/items -H "Content-Type: application/json" -d '{"title":"..."}'`

## 監査ログ

- items / sources / annotations への insert・update・delete は、`src/lib/db.ts` の共通 CRUD ヘルパーから `audit_logs` テーブル（`migrations/003_add_audit_log.sql`）に自動で記録される（`table_name` / `record_id` / `action` / `actor` / `before` / `after`）。
- `actor` は Basic 認証で検証したユーザー名（`context.locals.actor`）がそのまま入る。
- `GET /api/audit`（要認証）で一覧参照できる。`table` / `recordId` / `limit`（既定50、上限200）で絞り込み可能。例: `curl -u <ADMIN_USERNAME>:<ADMIN_PASSWORD> "http://localhost:4321/api/audit?table=items&recordId=123"`
- 監査ログの記録に失敗しても本来の書き込み処理は止めず、`console.error` に記録するのみ（記事単位の失敗を吸収する既存方針と同様）。

## CSV エクスポート

- `GET /api/export/items.csv`（認証不要、公開データの閲覧と同等）で items 一覧を CSV 出力できる。
- `/api/items` と同じ `q` / `kind` / `tag` / `sourceId` フィルタが使える（`limit` は無く、条件に合致する全件を出力する）。
- 出力列: `id,title,kind,source_name,source_type,external_url,published_at,tags,summary,version,created_at`（`tags` は `;` 区切り）。Excel(Windows) で文字化けしないよう UTF-8 BOM を付与している。

## Qiita 収集ジョブ

- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons`、既定は毎日 21:00 UTC = JST 6:00）が `src/worker.ts` の `scheduled` ハンドラを起動し、`resolveQiitaSyncOptions` で既定条件（ページ数など。検索語は `src/lib/importers/keywords.ts` のコード管理）を解決して `syncQiitaCollection` を実行する。
- 手動で同じ処理を起動したい場合は、ローカルなら `npm run collect:qiita`、デプロイ後は `POST /api/import/qiita` を叩く。`sources.origin_url` / `items.external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。
- 失敗時: `wrangler tail` や Cloudflare ダッシュボードのログで `[cron:qiita] sync failed` を確認する。記事単位の失敗はバッチを止めずに `skipped` として結果に積まれるため、ログに出る全体失敗は Qiita API 全断や Supabase 未接続など致命的なケースのみ。復旧を確認したら、次回 cron を待つか上記の手動実行で同じ内容を再実行すればよい。

## Zenn 収集ジョブ

- Zenn には公式 API が無いため、実際のサイトで使われている非公式エンドポイント（`/api/articles?topicname=`、`/api/articles/{slug}`）を利用している。仕様変更で壊れる可能性がある点に留意する。
- 収集条件はキーワードではなく `topic`（Zenn のトピックスラッグ、既定は `pokemon`）で絞り込む。Zenn の記事一覧 API はキーワード全文検索に対応していないため。
- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons` に Qiita とは別枠で追加、既定は毎日 21:30 UTC = JST 6:30）が `src/worker.ts` の `scheduled` ハンドラを起動する。`controller.cron` の値で Qiita/Zenn どちらのジョブかを振り分けている。
- 手動で起動したい場合は、ローカルなら `npm run collect:zenn`、デプロイ後は `POST /api/import/zenn` を叩く。Qiita と同様に `external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。
- 失敗時: `wrangler tail` などで `[cron:zenn] sync failed` を確認する。記事単位（詳細取得・AI レビュー・DB 書き込みのいずれか）の失敗は `skipped` に吸収されるため、ジョブ全体が落ちるのは Zenn 側の仕様変更やレート制限など致命的なケースのみ。復旧を確認したら、次回 cron を待つか手動実行で再実行すればよい。

## note 収集ジョブ

- note にも公式 API が無いため、非公式エンドポイント（`/api/v3/searches`、`/api/v3/notes/{key}`）を利用している。仕様変更で壊れる可能性がある点に留意する。
- 収集条件は Qiita と同様にキーワード（既定は `ポケモン`）で検索する。有料記事・メンバーシップ限定記事は本文を取得できないため、一覧取得の時点で `can_read=false` のものを除外している。
- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons` に Qiita/Zenn とは別枠で追加、既定は毎日 22:00 UTC = JST 7:00）が `src/worker.ts` の `scheduled` ハンドラを起動する。`controller.cron` の値で Qiita/Zenn/note のどのジョブかを振り分けている。
- 手動で起動したい場合は、ローカルなら `npm run collect:note`、デプロイ後は `POST /api/import/note` を叩く。Qiita/Zenn と同様に `external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。
- 失敗時: `wrangler tail` などで `[cron:note] sync failed` を確認する。記事単位（詳細取得・AI レビュー・DB 書き込みのいずれか）の失敗は `skipped` に吸収されるため、ジョブ全体が落ちるのは note 側の仕様変更やレート制限など致命的なケースのみ。復旧を確認したら、次回 cron を待つか手動実行で再実行すればよい。

## はてなブックマーク収集ジョブ

- はてなブックマークにも公式のキーワード検索APIは無いため、検索RSS（`b.hatena.ne.jp/search/text?q=...&mode=rss`）を利用する。ブックマークされた全ウェブページを横断する検索のため、Qiita/Zenn/noteのような単一プラットフォーム向けインポーターとは性質が異なり、発見した記事は `src/lib/importers/blog.ts` と同じ汎用HTML抽出で本文を取得する。
- **収集精度について**: 実測の結果、複数キーワードを与えても実質AND検索にならず、話題性の高い無関係な最近の記事（例: 生成AI関連ニュース）が上位に混入することを確認している（詳細は [docs/progress/2026-07-07.md](docs/progress/2026-07-07.md)）。これは note 収集ジョブで過去に確認した「母集団の性質上の問題」と同種と判断し、既存のAIレビュー（`article-ai.ts`）を安全網として運用しつつ、新規ソースのため候補数はキーワードあたり既定15件（`HATENA_MAX_CANDIDATES`）に絞ってOpenAIコストを抑えている。
- `b.hatena.ne.jp/robots.txt` の `Crawl-delay: 5` に従い、キーワードごとのリクエスト間隔を5秒空けている。
- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons` に他ジョブとは別枠で追加、既定は毎日 23:30 UTC = JST 8:30）が `src/worker.ts` の `scheduled` ハンドラを起動する。
- 手動で起動したい場合は、ローカルなら `npm run collect:hatena`、デプロイ後は `POST /api/import/hatena` を叩く。他インポーターと同様に `external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。`scripts/collect/backfill.mjs` の既定対象（`BACKFILL_TARGETS`）には含まれないため、使う場合は明示的に指定する。
- 失敗時: `wrangler tail` などで `[cron:hatena] sync failed` を確認する。記事単位の失敗は `skipped` に吸収されるため、ジョブ全体が落ちるのははてなブックマーク側の仕様変更など致命的なケースのみ。復旧を確認したら、次回 cron を待つか手動実行で再実行すればよい。

## リンク切れ検出ジョブ

- 元記事の削除・非公開化を検出するため、`items.external_url` を定期チェックし判定を `items.link_status`（`ok` / `broken`）・`link_checked_at`・`link_broken_since` に記録する（`migrations/016_add_link_status.sql`、実装は `src/lib/importers/link-check.ts`）。他の収集ジョブと異なり新規アイテムは作らない。
- 1回の到達不能（404/410、または DNS 解決失敗などの接続不可）だけでは確定させず、`link_broken_since` に「疑い開始時刻」を記録したうえで、次回チェックでも到達不能なら `link_status='broken'` に確定する（一時的な障害を誤検知しないため）。復帰したら即座に `ok` へ戻す。
- `link_status='broken'` のアイテムは新着・検索・タグ・人気順などの一覧（`src/lib/catalog.ts` の `queryCatalogItems`、RSS・サイトマップも同経由）から除外される。詳細ページやブックマーク一覧は対象外で、直接アクセスすれば引き続き閲覧できる。
- チェック対象は「未チェック、または `LINK_CHECK_RECHECK_DAYS`（既定7日）より前にチェック済み」のアイテムのうち、`link_checked_at` が古い順に `LINK_CHECK_BATCH_LIMIT`（既定100）件まで（1回のチェックで全件を毎回叩くと対象サイトへの負荷や実行時間が無視できないため）。
- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons` に他ジョブとは別枠で追加、既定は毎日 23:00 UTC = JST 8:00）が `src/worker.ts` の `scheduled` ハンドラを起動する。
- 手動で起動したい場合は、ローカルなら `npm run collect:check-links`、デプロイ後は `POST /api/import/check-links` を叩く。`id` をキーに更新するだけなので、何度実行しても副作用は増えない（冪等）。
- 失敗時: `wrangler tail` などで `[cron:link-check] check failed` を確認する。記事単位（fetch失敗・DB更新失敗）の失敗は `skipped` に吸収されるため、ジョブ全体が落ちるのは Supabase 未接続など致命的なケースのみ。復旧を確認したら、次回 cron を待つか手動実行で再実行すればよい。

## 検索・フィルタ・タグの精度を最適化するフロー

実データに対して「試行→Claude Codeが評価→修正→再実行」のループを回すためのスクリプト群。OpenAI 等の外部AIでの自動採点は使わず、Claude Code 自身が出力を読んで判定する（コストをかけないため）。4つの観点は独立したスクリプトに分かれており、それぞれ単独で反復できる。

- **収集クエリ精度（AIレビュー前の母集団のノイズ）**: `npm run eval:collection`（DB・サーバーとも不要、Qiita/Zenn/note の公開APIを直接叩く）。`scripts/eval/eval-collection.mjs` が各サービスの現在の既定クエリ・トピックで検索し、AIレビューを通す前の生のタイトル一覧を出力する。Claude Code がタイトルを見て、ポケモンのプログラミング・開発と無関係な記事（ゴミ）がどれだけ混ざっているかを判定し、多ければ各インポーター（`qiita.ts`/`zenn.ts`/`note.ts`）の `DEFAULT_QUERY`/`DEFAULT_TOPIC` や検索構文を見直して再実行する。
- **検索精度**: `npm run eval:search`（`astro dev --background` で起動したサーバーが必要）。`scripts/eval/eval-search.mjs` の `CASES` にある代表クエリを実際に `/api/items` へ投げ、ヒット件数とタイトルを出力する。Claude Code がタイトルを見て関連性・想定外のヒット漏れを判定し、問題があれば `src/lib/catalog.ts` の検索条件を直し、再実行して確認する。
- **フィルタ精度（AI取り込みレビューの採用可否）**: `npm run eval:filter`（DB 接続のみで可、サーバー起動は不要）。`scripts/eval/eval-filter.mjs` が `src/lib/importers/article-ai.ts` の現在のシステムプロンプトと、収集済み記事（採用分。title/summary/tags/収集時のAI判定）を並べて出力する。Claude Code がプロンプトの基準に照らして各記事を自分で読み直し、収集時の判定とズレがあれば（例: 主題がポケモンでないのに accepted=true）プロンプトを修正して再実行する。棄却された記事も `ai_accepted=false` 付きで `items` に保存され一覧・検索からは除外されるため（偽陰性レビュー、`migrations/018`）、同スクリプトはこれらを「偽陰性候補」として別セクションで新しい順に出力し、誤って棄却していないかも判定できる。
- **タグ精度**: `npm run eval:tags`（DB 接続のみで可）。`scripts/eval/eval-tags.mjs` がタグごとの使用件数とサンプル記事タイトルを出力し、使用1件のみのタグ一覧も出す。Claude Code が表記ゆれ・重複・ノイズタグを判定し、`normalizeTagName`（`src/lib/importers/article-ai.ts`）や関連マイグレーションで是正して再実行する。
- 収集時に AI が新規タグを乱発しないよう、各インポーターは収集開始時に既存タグ上位（`fetchTopTagNames`、`src/lib/importers/common.ts`）を取得し、AIレビューのプロンプトに再利用ヒントとして渡している。この効果は次回以降の実収集（Qiita/Zenn/note の cron または手動実行）でしか確認できない点に注意。
- `npm run eval:all` で上記4観点（収集クエリ/検索/フィルタ/タグ）に加えて `scripts/db/detect-duplicate-items.mjs`（重複items検出）も1コマンドでまとめて実行できる（`scripts/eval/eval-all.mjs`）。検索精度の実行に必要な開発サーバーが未起動なら自動で `astro dev --background` を起動し、このスクリプトが起動した場合に限り終了時に停止する。個人ブログ（Brave Search）のクエリ精度は Brave の無料枠（月1000件）を消費するため既定では実行せず、`npm run eval:all -- --with-blog` を付けたときのみ実行する。
