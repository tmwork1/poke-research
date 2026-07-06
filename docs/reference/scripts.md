# scripts/ 一覧

`scripts/` 配下の各スクリプトを、開発・運用のどのフェーズで使うかで整理する。収集ジョブの詳しい仕様やAPIの認証は [README](../../README.md) を、デプロイ・バックアップ手順は [operations.md](operations.md) を参照する。レビュー・クリーンアップ系の不足点は [docs/plan/review-scripts-gaps-20260706.md](../plan/review-scripts-gaps-20260706.md) にまとめてある。

共通の前提:
- ほとんどのスクリプトは `DATABASE_URL`（直接 `pg` 接続）または `SUPABASE_URL`/`SUPABASE_SECRET_KEY`（`@supabase/supabase-js` 経由）のどちらかを要求する。ローカルは `scripts/db/setup-env.ps1` で作った `.env` を `node --env-file=.env scripts/xxx.mjs` で読み込むか、`npm run` 経由（エイリアスがあるもの）で実行する。
- 本番 DB に対して書き込みを行うスクリプトは、実行前に必ずユーザー確認を取る（CLAUDE.md の運用ルール）。
- 各表中の **（未実装）** はまだ存在せず、[docs/plan/review-scripts-gaps-20260706.md](../plan/review-scripts-gaps-20260706.md) で提案だけされているスクリプト。実装フェーズ・体系上の位置づけを分かりやすくするため、既存スクリプトと同じ表に並べている。
- **課金**列は外部有料APIの利用有無を示す。`OpenAI` は従量課金（件数に比例）、`Brave` は無料枠（月1000件）の消費。Supabase/DB 接続や Qiita・Zenn・note の公開APIは課金対象外なので「なし」と表記する。

## 1. 初期セットアップ・ローカル環境構築

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/db/setup-env.ps1` | `./scripts/db/setup-env.ps1` | 対話形式で `.env` を新規作成する（`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY`/`DATABASE_URL`）。既存 `.env` は上書き確認あり。 | なし |
| `scripts/db/run-migrations.mjs` | `npm run migrate` | 未適用の `migrations/*.sql` を順に適用する。適用済みは `migrations` テーブルで判定（冪等）。ローカル初期化・本番リリース双方の共通実体。 | なし |
| `scripts/db/grant-dev-perms.mjs` | `node scripts/db/grant-dev-perms.mjs` | ローカル開発用に `public` スキーマ全体へ広い権限を `PUBLIC` に付与する。ローカル専用、本番では使わない。 | なし |
| `scripts/db/seed-dev-user.mjs` | `node scripts/db/seed-dev-user.mjs` | `astro dev` のダミーセッションユーザーと同じ id で `auth.users`/`public.users` にレコードを作る（お気に入り機能のFK検証用）。ローカル専用。 | なし |
| `scripts/db/seed-sample-article.mjs` | `node scripts/db/seed-sample-article.mjs` | サンプル記事1件（source/item/summary annotation）を固定データで upsert する。動作確認・デモ用。 | なし |
| `scripts/db/test-db.mjs` | `node scripts/db/test-db.mjs` | 基本 CRUD（sources/items/annotations）と監査ログの疎通確認スモークテスト。挿入したテストデータは自動削除。スキーマ変更時・デプロイ手順でも使う（下記「4. リリース」参照）。 | なし |

## 2. 収集（定期実行ジョブの手動起動）

いずれも対応する `/api/import/*` エンドポイントへの薄いPOSTラッパーで、クエリ・ページ数などをenvで上書きできる（未指定時はAPI側の既定値）。

| スクリプト | コマンド | 用途・上書き可能なenv | 課金 |
|---|---|---|---|
| `scripts/collect/collect-qiita.mjs` | `npm run collect:qiita` | Qiita収集。`QIITA_QUERY`/`QIITA_PAGES`/`QIITA_PER_PAGE`/`QIITA_TOKEN`。 | OpenAI（新規記事のAIレビュー） |
| `scripts/collect/collect-zenn.mjs` | `npm run collect:zenn` | Zenn収集。`ZENN_TOPIC`/`ZENN_PAGES`。 | OpenAI（新規記事のAIレビュー） |
| `scripts/collect/collect-note.mjs` | `npm run collect:note` | note収集。`NOTE_QUERY`/`NOTE_PAGES`。 | OpenAI（新規記事のAIレビュー） |
| `scripts/collect/collect-blog.mjs` | `npm run collect:blog` | Brave Search経由の個人ブログ収集。`BLOG_QUERY`/`BRAVE_COUNT`/`BLOG_PAGES`。Brave無料枠（月1000件）に注意。 | OpenAI + Brave |
| `scripts/collect/check-links.mjs` | `npm run collect:check-links` | リンク切れ検出ジョブを手動起動。`LINK_CHECK_BATCH_LIMIT`/`LINK_CHECK_CONCURRENCY`/`LINK_CHECK_RECHECK_DAYS`。 | なし |
| `scripts/collect/backfill.mjs` | `npm run collect:backfill` | qiita/zenn/note/blogをまとめて広めの範囲で一括収集する。対象は`BACKFILL_TARGETS`（既定`qiita,zenn,note,blog`）で絞れる。本番実行はレートリミット・OpenAI課金に注意しユーザー確認の上で行う。 | OpenAI + Brave（一括収集のため件数大） |

## 3. 評価ループ（試行→評価→修正）

外部AIによる自動採点はせず、各スクリプトは判定材料（生データ）を出力するだけで、Claude Codeがその出力を読んで判定→該当箇所を修正→再実行、というループを回す（`detect-duplicate-items` のみ判定材料に加えてクリーンアップの検出結果そのものが出力）。

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/eval/eval-all.mjs` | `npm run eval:all`（`-- --with-blog` で blog も追加） | 下記4本（collection/filter/tags/search）に加え、`scripts/db/detect-duplicate-items.mjs`（重複items検出）も含めた計5本をまとめて1コマンドで実行するオーケストレーター。`eval:search`用の開発サーバーが未起動なら自動起動し、このスクリプト自身が起動した場合に限り終了時に停止する。 | なし（`--with-blog` 時のみ Brave） |
| `scripts/eval/eval-collection.mjs` | `npm run eval:collection` | 収集クエリ精度: Qiita/Zenn/noteの生検索結果（AIレビュー前）のタイトル一覧を出す。DB・サーバー不要。 | なし |
| `scripts/eval/eval-collection-blog.mjs` | `npm run eval:collection:blog` | 収集クエリ精度（ブログ）: Brave Searchの生検索結果を出す。`BRAVE_API_KEY`必須、無料枠を消費するため`eval:all`の既定実行には含めない。 | Brave |
| `scripts/eval/eval-search.mjs` | `npm run eval:search` | 検索精度: 起動中サーバー（`EVAL_BASE_URL`、既定`http://localhost:4321`）に代表的な検索クエリを投げ、ヒット件数とタイトルを出す。 | なし |
| `scripts/eval/eval-filter.mjs` | `npm run eval:filter` | フィルタ精度: 現在のAI取り込みプロンプトと、収集済み全記事のtitle/summary/tags/AI採否理由を並べて出す。`DATABASE_URL`必須。 | なし |
| `scripts/eval/eval-tags.mjs` | `npm run eval:tags` | タグ精度: タグごとの使用件数とサンプル記事タイトルを出す。使用1件のみのタグ（ノイズ候補）に加え、`tags`と`item_tags`のLEFT JOINで使用0件のタグ（統合後の残骸等）も削除候補として別掲する。`DATABASE_URL`必須。 | なし |
| **（未実装）** `scripts/eval/eval-filter.mjs` の偽陰性レビュー拡張 | — | フィルタ精度: `eval-filter.mjs`はDBに入った記事（AIに採用された記事）しか見られず、誤って棄却された記事（偽陰性）を原理的に検出できない。案A（棄却記事も非表示フラグ付きで保存）/案B（棄却ログ専用テーブル）を提案中。スキーマ変更を伴うため着手前にユーザー判断が必要。詳細: [gapsプラン#4](../plan/review-scripts-gaps-20260706.md)。 | なし（想定） |

## 4. レビュー・クリーンアップ（事後メンテナンス）

収集済みデータの重複・表記ゆれ・古い判定結果を後から手直しするための、都度手動実行するスクリプト。

**実行のきっかけ**: レビュー・クリーンアップのトリガーは実質2つ。

- **収集後**（backfill や新ソース追加の後）: 重複・新タグは収集が作るため、`detect-duplicate-items`（`eval:all` に含まれる）の結果確認と `backfill-tag-explanations` を行う。
- **AI取り込みプロンプト（`src/lib/importers/article-ai.ts`）や要約基準の変更後**: 既存記事が旧基準のまま残るため `retag-existing-items` の要否を検討する。

`merge-tag` は上記とは別に、`eval:all` の `eval:tags` 出力でノイズタグ・表記ゆれが見えたときに使う。同様に `merge-source` は `detect-duplicate-sources` の出力で重複sourceが見えたときに使う。`eval-annotations`・`eval-broken-links` は上記2トリガーとは独立に、annotations件数が増えてきたときや月次の目視確認のタイミングで都度実行する。

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/db/detect-duplicate-items.mjs` | `node scripts/db/detect-duplicate-items.mjs` | 同一記事のクロスポスト候補を、URL正規化一致 or タイトル類似度で検出し一覧表示する。読み取り専用（DBに書き込まない）。統合・削除は手動対応。`npm run eval:all` の既定ステップにも含まれる。 | なし |
| `scripts/db/merge-tag.mjs <from> <to>` | `node scripts/db/merge-tag.mjs ポケモンカート ポケモンカード` | 誤字・表記ゆれタグを正しいタグへ統合する（`item_tags`付け替え→`from`削除）。冪等。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/backfill-tag-explanations.mjs` | `node --env-file=.env scripts/db/backfill-tag-explanations.mjs` | `explained_at`未設定のタグへ、AIによる平易な解説をまとめて生成する。冪等（生成済みはスキップ）。OpenAI課金に注意。 | OpenAI（未解説タグの件数分） |
| `scripts/db/retag-existing-items.mjs` | `node --env-file=.env scripts/db/retag-existing-items.mjs [--dry-run] [--id=] [--limit=] [--service=]` | 既存アイテムへ現行のAI取り込みプロンプトを再適用し、summary/タグを最新基準で更新し直す。不採用判定になった場合は自動削除せず警告のみ。全件実行はOpenAI課金が大きいので事前確認。 | OpenAI（既定は全件、`--limit`等で抑制。`--dry-run`でも呼び出しあり） |
| `scripts/db/detect-duplicate-sources.mjs` | `node scripts/db/detect-duplicate-sources.mjs` | sources専用の重複検出。`origin_url`の正規化一致・`name`の類似度で候補を出す（`detect-duplicate-items.mjs`の正規化ロジックを流用）。読み取り専用（DBに書き込まない）。統合は`merge-source.mjs`で行う。 | なし |
| `scripts/db/merge-source.mjs <from-id> <to-id>` | `node scripts/db/merge-source.mjs 56 3` | 重複source統合。`merge-tag.mjs`と同様のパターン（items の`source_id`を付け替えてから重複sourceを削除）。冪等。`--dry-run`で付け替え対象件数と削除予定sourceの表示のみ行える。本番実行前にユーザー確認必須。 | なし |
| **（未実装）** `scripts/db/resolve-duplicate-items.mjs`（対話的ヘルパー） | 未定（提案） | `detect-duplicate-items.mjs`の検出結果を「検出→確認→削除」まで一本化する運用ヘルパー。`item_relations`テーブルは運用されず`migrations/017`で削除済みのため、保存済みペアを前提にせず実行のたびに検出したペアへ直接作用する設計が必要。詳細: [gapsプラン#3](../plan/review-scripts-gaps-20260706.md)。 | なし（想定） |
| `scripts/eval/eval-annotations.mjs` | `node scripts/eval/eval-annotations.mjs` | annotations（`GET/POST /api/annotations`）の内容を記事タイトルと紐付けて一覧出力する読み取り専用スクリプト。`DATABASE_URL`必須。 | なし |
| `scripts/eval/eval-broken-links.mjs` | `node scripts/eval/eval-broken-links.mjs` | `link_status='broken'`のitemを`link_broken_since`の古い順に一覧出力する。`eval:all`とは別に月次程度で目視確認する運用を想定。`DATABASE_URL`必須。 | なし |

## 5. リリース（本番マイグレーション適用）

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/release.mjs` | `npm run release` | `DATABASE_URL`を`.env`から読み込み`npm run migrate`を実行するだけ。本番デプロイ前（`main` push前）にマイグレーションだけ先に適用するためのラッパー。ビルド・デプロイ自体はCloudflareのGitHub連携が担う（[operations.md](operations.md)の「デプロイ手順」参照）。 | なし |

## 6. 調査・非常時ユーティリティ

普段の開発フローには登場しない、DB状態の確認や強制初期化用のスクリプト。

| スクリプト | コマンド | 用途 | 課金 | 注意 |
|---|---|---|---|---|
| `scripts/db/list-tables.mjs` | `node scripts/db/list-tables.mjs` | `public`スキーマのテーブル名一覧を表示する。 | なし | 読み取り専用。 |
| `scripts/db/check-items-columns.mjs` | `node scripts/db/check-items-columns.mjs` | `items`テーブルのカラム名・型一覧を表示する。 | なし | 読み取り専用。 |
| `scripts/db/drop-app-tables.mjs` | `node scripts/db/drop-app-tables.mjs` | 主要アプリテーブル（annotations/item_tags/items/research_note_items/research_notes/sources/tags/users）を固定リストで`DROP TABLE CASCADE`。 | なし | 破壊的操作。ローカル再構築専用、本番では使わない。誤実行防止ガードあり: 接続先ホストと一致する`DROP_TARGET_HOST`環境変数を設定しないと実行できない。 |
| `scripts/db/drop-non-migrations-tables.mjs` | `node scripts/db/drop-non-migrations-tables.mjs [--dry-run]` | `public`スキーマの`migrations`以外の全テーブルを`DROP TABLE CASCADE`。 | なし | 破壊的操作。ローカル再構築専用、本番では使わない。誤実行防止ガードあり（`--dry-run`は対象外）: 接続先ホストと一致する`DROP_TARGET_HOST`環境変数を設定しないと実行できない。 |

## ドキュメント化されていない/確認が必要な既知の穴

[docs/plan/review-scripts-gaps-20260706.md](../plan/review-scripts-gaps-20260706.md) に、sources重複検出・使用0件タグ検出・items重複の運用ループ化・AIフィルタ偽陰性レビュー・annotationsレビュー・リンク切れ目視レビューの6点を優先度/工数付きで整理してある。このうちsources重複検出・使用0件タグ検出・annotationsレビュー・リンク切れ目視レビューの4点は本表に実装済みとして反映済み。items重複の運用ループ化（対話的な検出→確認→削除の一本化）とAIフィルタ偽陰性レビューは未着手のまま残っている。
