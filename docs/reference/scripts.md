# scripts/ 一覧

`scripts/` 配下の各スクリプトを、開発・運用のどのフェーズで使うかで整理する。収集ジョブの詳しい仕様やAPIの認証は [README](../../README.md) を、デプロイ・バックアップ手順は [operations.md](operations.md) を参照する。

共通の前提:
- ほとんどのスクリプトは `DATABASE_URL`（直接 `pg` 接続）または `SUPABASE_URL`/`SUPABASE_SECRET_KEY`（`@supabase/supabase-js` 経由）のどちらかを要求する。ローカルは `scripts/db/setup-env.ps1` で作った `.env` を `node --env-file=.env scripts/xxx.mjs` で読み込むか、`npm run` 経由（エイリアスがあるもの）で実行する。
- 本番 DB に対して書き込みを行うスクリプトは、実行前に必ずユーザー確認を取る（CLAUDE.md の運用ルール）。
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
| `scripts/collect/collect-hatena.mjs` | `npm run collect:hatena` | はてなブックマーク検索RSS経由の記事収集。`HATENA_KEYWORD`/`HATENA_MAX_CANDIDATES`。全ウェブ横断検索のため収集精度が低いことが判明済み（[docs/progress/2026-07-07.md](../progress/2026-07-07.md)）、AIレビューを安全網として運用する方針。既定の`BACKFILL_TARGETS`には含まれない。 | OpenAI |
| `scripts/collect/collect-feed.mjs` | `npm run collect:feed` | 登録済みRSS/Atomフィード（`feed_subscriptions`、migrations/022）を直接ポーリングする収集。`FEED_MAX_ENTRIES`。フィードはblog.ts/hatena.tsがAIレビュー採用済み記事のページから自動登録するため事前の手動登録は不要。既定の`BACKFILL_TARGETS`には含まれない。 | OpenAI |
| `scripts/collect/collect-arxiv.mjs` | `npm run collect:arxiv` | arXiv API経由の論文収集（`items.kind='paper'`）。`ARXIV_QUERY`/`ARXIV_MAX_RESULTS`。cronには未組み込みで手動起動のみ（[docs/plan/paper.md](../plan/paper.md)）。既定の`BACKFILL_TARGETS`には含まれない。 | OpenAI |
| `scripts/collect/backfill.mjs` | `npm run collect:backfill` | qiita/zenn/note/blogをまとめて広めの範囲で一括収集する。対象は`BACKFILL_TARGETS`（既定`qiita,zenn,note,blog`、`hatena`は明示指定時のみ対象）で絞れる。本番実行はレートリミット・OpenAI課金に注意しユーザー確認の上で行う。 | OpenAI + Brave（一括収集のため件数大） |
| `scripts/collect/check-links.mjs` | `npm run collect:check-links` | リンク切れ検出ジョブを手動起動。`LINK_CHECK_BATCH_LIMIT`/`LINK_CHECK_CONCURRENCY`/`LINK_CHECK_RECHECK_DAYS`。 | なし |

## 3. 評価ループ（試行→評価→修正）

外部AIによる自動採点はせず、各スクリプトは判定材料（生データ）を出力するだけで、Claude Codeがその出力を読んで判定→該当箇所を修正→再実行、というループを回す（`detect-duplicate-items` のみ判定材料に加えてクリーンアップの検出結果そのものが出力）。`eval-filter`（フィルタ精度）のようにAI取り込みプロンプト自体を修正する場合は、プロンプトファイルの再実行だけで満足せず、修正後プロンプトを実際にOpenAIへ送って問題事例の判定が意図通り変わるかを少数再テストしてから、既存記事全体への反映（`retag-existing-items`）を検討する（実例: [docs/optimization/filter-accuracy.md](../optimization/filter-accuracy.md)）。プロンプトやモデル（`OPENAI_MODEL`）を変えて少数再テストする実験は、1回実行するごとに結果を `docs/optimization/` 配下へ逐一記録する（まとめて後で書かない。実験→記録→次の実験を1サイクルとして繰り返す）。記録には accepted/rejected を問わず reason・confidence・language を含める（`retag-existing-items.mjs` は元々 accepted 分岐で reason を出力しないバグがあったため、両分岐で出力するよう修正済み）。

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/eval/eval-all.mjs` | `npm run eval:all`（`-- --with-blog` で blog も追加） | 下記4本（collection/filter/tags/search）に加え、`scripts/db/detect-duplicate-items.mjs`（重複items検出）も含めた計5本をまとめて1コマンドで実行するオーケストレーター。`eval:search`用の開発サーバーが未起動なら自動起動し、このスクリプト自身が起動した場合に限り終了時に停止する。 | なし（`--with-blog` 時のみ Brave） |
| `scripts/eval/eval-collection.mjs` | `npm run eval:collection` | 収集クエリ精度: Qiita/Zenn/noteの生検索結果（AIレビュー前）のタイトル一覧を出す。DB・サーバー不要。 | なし |
| `scripts/eval/eval-collection-blog.mjs` | `npm run eval:collection:blog` | 収集クエリ精度（ブログ）: Brave Searchの生検索結果を出す。`BRAVE_API_KEY`必須、無料枠を消費するため`eval:all`の既定実行には含めない。 | Brave |
| `scripts/eval/eval-collection-hatena.mjs` | `npm run eval:collection:hatena` | 収集クエリ精度（はてなブックマーク）: 検索RSSの生結果を出す。DB・APIキー不要。robots.txtのCrawl-delay(5秒)に従いキーワード間で待機する。 | なし |
| `scripts/eval/eval-recall.mjs` | `npm run eval:recall -- --source=arxiv`（他に`qiita`/`zenn`/`note`） | 収集アルゴリズムの再現率チェック: 上記`eval-collection*`とは逆方向に、Brave Searchで対象ドメイン（`site:`絞り込み）から候補を独立に探し、DB収録済み（`items.external_url`）と突き合わせて未収録候補（収集クエリの見落とし候補）を一覧表示する。`--keyword=`で特定キーワードのみに絞れる（省略時は`topic.collection.searchKeywords`全件、Brave無料枠を消費）。`DATABASE_URL`・`BRAVE_API_KEY`必須。実例: arXivの検索インデックスがアクセント記号のfoldingをしないため"Pokémon"表記のみの論文が漏れていたことをこの手法で発見した（[docs/plan/paper.md](../plan/paper.md)）。 | Brave |
| `scripts/eval/eval-filter.mjs` | `npm run eval:filter` | フィルタ精度: 現在のAI取り込みプロンプトと、収集済み記事（採用分）のtitle/summary/tags/AI採否理由を並べて出す。加えて、AIに棄却された記事（案A、migrations/018で`ai_accepted=false`付きのまま`items`に保存されるようになった記事）も「偽陰性候補」セクションとしてtitle/external_url/棄却理由/AI要約を新しい順に別掲し、誤棄却でないかをレビューできるようにする。`DATABASE_URL`必須。 | なし |
| `scripts/eval/eval-tags.mjs` | `npm run eval:tags` | タグ精度: タグごとの使用件数とサンプル記事タイトルを出す。使用1件のみのタグ（ノイズ候補）に加え、`tags`と`item_tags`のLEFT JOINで使用0件のタグ（統合後の残骸等）も削除候補として別掲する。`DATABASE_URL`必須。 | なし |
| `scripts/eval/eval-search.mjs` | `npm run eval:search` | 検索精度: 起動中サーバー（`EVAL_BASE_URL`、既定`http://localhost:4321`）に代表的な検索クエリを投げ、ヒット件数とタイトルを出す。 | なし |
| `scripts/eval/eval-subrequests.mjs` | `npm run eval:subrequests` | Cloudflare Workers subrequest消費量の実測: 収集6ルート（qiita/zenn/arxiv/hatena/blog/feed）それぞれに`maxNewItemsPerRun=0`→`=1`の順でPOSTし、固定コストと新規1件あたりのコストを実測、既定`maxNewItemsPerRun`でのワーストケースを算出する。事前に`ADMIN_USERNAME`/`ADMIN_PASSWORD`を`.env`に設定し、dev serverを`DEBUG_SUBREQUEST_COUNT=1`付きで起動しておく必要がある（`.dev.vars`に追記してから再起動。`src/middleware.ts`・`src/lib/subrequest-counter.ts`）。管理者APIへの実書き込み・実際の外部APIコストが発生するため`eval:all`には含めない。 | OpenAI（新規1件分×6ルート）+ Brave（blogのみ） |

## 4. レビュー・クリーンアップ（事後メンテナンス）

収集済みデータの重複・表記ゆれ・古い判定結果を後から手直しするための、都度手動実行するスクリプト。

**実行のきっかけ**: レビュー・クリーンアップのトリガーは実質2つ。

- **収集後**（backfill や新ソース追加の後）: 重複・新タグは収集が作るため、`detect-duplicate-items`（`eval:all` に含まれる）の結果確認と `backfill-tag-explanations` を行う。
- **AI取り込みプロンプト（`src/lib/importers/article-ai.ts`、実体は `src/lib/importers/ai-review-prompt.mjs`）や要約基準の変更後**: 既存記事が旧基準のまま残るため `retag-existing-items` の要否を検討する。全件再適用の前に、まず修正の狙いとなった問題事例だけを `--id=<id> --dry-run` で少数再テストし、意図通り判定が変わるか確認する（棄却済み記事は `ai_accepted=true` の記事のみを対象とする `retag-existing-items` では拾えないため、使い捨てスクリプトで別途確認する）。

`merge-item` は `detect-duplicate-items` の出力で重複itemが見えたとき、著者・内容を確認して同一記事と判断できたペアにのみ使う（タイトルが似ているだけで内容が別の記事は統合対象外）。同様に `merge-source` は `detect-duplicate-sources` の出力で重複sourceが見えたときに使う。`merge-tag`（表記ゆれの統合）・`rename-tag`（冗長・冗長な接頭辞の短縮など単純リネーム）・`delete-tag`（検索価値の低い不適切タグの削除）は上記2つとは別に、`eval:all` の `eval:tags` 出力でノイズタグ・表記ゆれ・短縮の余地が見えたときに使い分ける。`eval-annotations`・`eval-broken-links` は上記2トリガーとは独立に、annotations件数が増えてきたときや月次の目視確認のタイミングで都度実行する。

| スクリプト | コマンド | 用途 | 課金 |
|---|---|---|---|
| `scripts/db/detect-duplicate-items.mjs` | `npm run db:detect-duplicate-items` | 同一記事のクロスポスト候補を、URL正規化一致 or タイトル類似度で検出し一覧表示する。読み取り専用（DBに書き込まない）。「検出→確認→削除」を自動で一本化する対話的ヘルパーは、判断そのものを人手で行う必要があるためユーザー判断により不要と確定し、実装しない。統合は`merge-item.mjs`で行う。`npm run eval:all` の既定ステップにも含まれる。 | なし |
| `scripts/db/merge-item.mjs <from-id> <to-id>` | `node scripts/db/merge-item.mjs 34 224` | 重複item統合。`merge-source.mjs`と同様のパターン（`item_tags`/`bookmarks`を付け替え、`annotations`は付け替えたうえで`from`を削除）。冪等。`--dry-run`で付け替え対象件数と削除予定itemの表示のみ行える。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/detect-duplicate-sources.mjs` | `npm run db:detect-duplicate-sources` | sources専用の重複検出。`origin_url`の正規化一致・`name`の類似度で候補を出す（`detect-duplicate-items.mjs`の正規化ロジックを流用）。読み取り専用（DBに書き込まない）。統合は`merge-source.mjs`で行う。 | なし |
| `scripts/db/merge-source.mjs <from-id> <to-id>` | `node scripts/db/merge-source.mjs 56 3` | 重複source統合。`merge-tag.mjs`と同様のパターン（items の`source_id`を付け替えてから重複sourceを削除）。冪等。`--dry-run`で付け替え対象件数と削除予定sourceの表示のみ行える。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/merge-tag.mjs <from> <to>` | `node scripts/db/merge-tag.mjs ポケモンカート ポケモンカード` | 誤字・表記ゆれタグを正しいタグへ統合する（`item_tags`付け替え→`from`削除）。冪等。`--dry-run`は未対応（実行すると即座に本番へ反映される点に注意）。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/rename-tag.mjs <from> <to>` | `node scripts/db/rename-tag.mjs ポケモン図鑑 図鑑` | 統合ではなく単純リネーム（`tags.name`を書き換えるだけ）。to タグが既に存在する場合は同義語統合とみなし merge-tag.mjs を案内して終了する。冪等。`--dry-run`で変更予定の表示のみ行える。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/delete-tag.mjs <tag>` | `node scripts/db/delete-tag.mjs テスト` | 検索価値の低い・不適切なタグを`item_tags`ごと削除する。冪等。`--dry-run`で削除予定件数の表示のみ行える。本番実行前にユーザー確認必須。 | なし |
| `scripts/db/backfill-tag-explanations.mjs` | `npm run db:backfill-tag-explanations` | `explained_at`未設定のタグへ、AIによる平易な解説をまとめて生成する。冪等（生成済みはスキップ）。OpenAI課金に注意。 | OpenAI（未解説タグの件数分） |
| `scripts/db/retag-existing-items.mjs` | `npm run db:retag-existing-items -- [--dry-run] [--id=] [--limit=] [--service=]` | 既存アイテムへ現行のAI取り込みプロンプトを再適用し、summary/タグを最新基準で更新し直す。`items.language`（migrations/021、記事本文の主な言語）は採否に関わらず常に更新する。不採用判定（言語がja/en以外と判定された場合を含む）になった場合はsummary/タグを自動削除せず警告のみ。全件実行はOpenAI課金が大きいので事前確認。 | OpenAI（既定は全件、`--limit`等で抑制。`--dry-run`でも呼び出しあり） |
| `scripts/db/delete-non-ja-en-items.mjs` | `node --env-file=.env.production scripts/db/delete-non-ja-en-items.mjs [--dry-run]` | `items.language`（migrations/021）が日本語・英語のいずれでもないと判定済み（`retag-existing-items.mjs`でバックフィル済み）のitemを削除する。language未判定（NULL）の行は対象外。`--dry-run`で削除予定一覧の表示のみ行える。本番実行前にユーザー確認必須。 | なし（判定済みのlanguage列を読むだけ） |
| `scripts/db/optimize-tags.mjs` | `node --env-file=.env scripts/db/optimize-tags.mjs` | タグ台帳全体（名前・使用件数・サンプル記事タイトル）を1回のOpenAI呼び出しに渡し、大文字小文字・冗長接頭辞の短縮化・不適切タグ削除・表記ゆれ統合の提案と、適用用の`rename-tag`/`merge-tag`/`delete-tag`コマンド例を出力する。読み取り専用（DBは書き換えない）。提案は無条件に適用せず必ず内容を確認すること。 | OpenAI（タグ数に応じた1リクエスト） |
| `scripts/eval/eval-annotations.mjs` | `npm run eval:annotations` | annotations（`GET/POST /api/annotations`）の内容を記事タイトルと紐付けて一覧出力する読み取り専用スクリプト。`DATABASE_URL`必須。 | なし |
| `scripts/eval/eval-broken-links.mjs` | `npm run eval:broken-links` | `link_status='broken'`のitemを`link_broken_since`の古い順に一覧出力する。`eval:all`とは別に月次程度で目視確認する運用を想定。`DATABASE_URL`必須。 | なし |

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
