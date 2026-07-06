# 仕様: Brave Search API による汎用ブログ収集

このドキュメントは、Qiita/Zenn/note 以外の個人ブログ等を Brave Search API 経由で発見し、既存の収集パイプラインに乗せて取り込むための設計をまとめたものである。実装前の設計合意として作成し、実装時はこの内容に従う。

## 背景・スコープ

- [docs/development-roadmap.md](../development-roadmap.md) M3 で「個人ブログは特定ブログの購読ではなく、Brave Search API（公式・ドキュメント化された検索API）でのキーワード検索により発見する方針とする。実装はリリース後のアップデートで対応」と決めている。本ドキュメントはそのアップデートの設計。
- Qiita/Zenn/note は各サービスの API がタイトル・本文・タグ・著者・日付を構造化して返すため、`src/lib/importers/{qiita,zenn,note}.ts` はそれぞれ専用のフィールドマッピングを書けている。個人ブログには共通 API が無いため、今回追加するのは **(1) Brave Search API での発見** と **(2) 発見した任意 URL からの汎用的な本文抽出** の2段階からなる新しい収集経路である。
- GitHub・YouTube は既存ロードマップの通り対象外のまま維持する。Brave Search の結果にこれらのドメインが混ざらないよう、検索クエリと結果フィルタの両方で除外する（後述）。
- 対象は個人ブログ・企業テックブログなど「記事」であり、SNS投稿・フォーラム・ECサイト等は想定しない。完全な自動判別はできないため、最終的な採否は既存の AI レビュー（`reviewImportArticle`）に委ねる。
- スコープ外: サイト全体のクロール（今回は Brave Search が返した個別記事URLのみを1件ずつ取得する）、記事本文の全文保存（既存インポーター同様、AIレビュー用に一時的に使うのみで DB には要約とタグしか残さない）。

## 全体フロー

```
POKEMON_KEYWORDS ごとに Brave Web Search API を呼ぶ
  → 除外ドメイン(qiita.com/zenn.dev/note.com/github.com/youtube.com 等)を検索クエリと結果フィルタの両方で除く
  → 結果 URL ごとに:
      1. 該当ページの HTML を fetch
      2. HTMLRewriter で title/meta/本文候補テキストを抽出
      3. 本文が短すぎる/HTMLでない場合は skipped
      4. items.version を既存レコードと比較し、未変更なら AIレビューを省略して skipped 扱い
      5. 変更あり/新規なら reviewImportArticle → 採用時に upsertItemByExternalUrl
  → sources は「ドメイン単位」で upsertSourceByOriginUrl
```

既存の `mapWithConcurrency` / `processImportItem` / `upsertItemByExternalUrl` / `upsertSourceByOriginUrl` / `syncItemTags` （`src/lib/importers/common.ts`）はそのまま再利用する。新規に書くのは「発見」と「汎用抽出」の部分のみ。

## 1. Brave Search API クライアント（`src/lib/brave.ts`）

`src/lib/openai.ts` と同じ形（Cloudflare env と `process.env` の両方から読む）で設定を読み込む。

```ts
export interface BraveConfig {
  apiKey: string;
}
export function getBraveConfig(): BraveConfig { /* BRAVE_API_KEY を読む */ }

export const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;          // Brave が推定した公開時期の文字列（例: "2026-05-01T00:00:00"）
  page_age?: string;
}

export async function braveWebSearch(query: string, options: { count?: number; offset?: number }): Promise<BraveWebResult[]>
```

- リクエストヘッダ: `X-Subscription-Token: <BRAVE_API_KEY>`, `Accept: application/json`。
- クエリパラメータ: `q`（除外ドメインを `-site:` で付与した最終クエリ文字列）, `count`（既定 20、Brave 側上限も 20）, `offset`（複数ページ取得用、既定 0）, `search_lang=jp`, `country=JP`。
- `BRAVE_API_KEY` 未設定時は Qiita インポーターの `OPENAI_API_KEY` 同様、明示的に throw して無通信のまま進めない。

## 2. 除外ドメインと検索クエリ構築

`src/lib/importers/keywords.ts` に追記する:

```ts
// Brave Search が対象外サービスや GitHub/YouTube を返さないよう、クエリの -site: と
// 結果フィルタの両方で使う共有リスト。
export const EXCLUDED_BLOG_DOMAINS = [
  'qiita.com', 'zenn.dev', 'note.com', 'github.com', 'youtube.com', 'x.com', 'twitter.com',
] as const;
```

クエリは `POKEMON_KEYWORDS` の各キーワードごとに1本組み立てる（Qiita の `title:` 方式のような対象限定演算子は Brave には無いため、単純なキーワード + `-site:` 除外のみ）:

```
ポケモン -site:qiita.com -site:zenn.dev -site:note.com -site:github.com -site:youtube.com -site:x.com -site:twitter.com
```

Brave が `-site:` を完全には遵守しないケースに備え、結果を受け取った後にも `new URL(result.url).hostname` が `EXCLUDED_BLOG_DOMAINS`（サブドメイン含む）に一致する場合は追加でスキップする（defense in depth）。

## 3. 汎用本文抽出（`src/lib/importers/blog.ts` 内、Cloudflare の `HTMLRewriter` を使用）

Qiita/Zenn/note は各 API が返す `body`/`rendered_body`/`body_html` を `stripHtml`（`common.ts`）に通すだけで済んだが、任意サイトにはその構造化フィールドが無い。ページ全体の HTML を取得し、`HTMLRewriter`（Cloudflare Workers 組み込み。追加依存なしでローカル dev の Cloudflare ランタイムでも動く）でストリーム処理し、以下を抽出する。

- タイトル: `meta[property="og:title"]` → `<title>` → Brave の `title` の順にフォールバック。
- 本文候補テキスト: `<article>` 要素があればその中のテキストノードのみ収集。無ければ `<main>`、それも無ければ `<body>` から `nav`/`header`/`footer`/`aside`/`script`/`style` 配下を除いたテキストノードを収集する。
- 公開日時: `meta[property="article:published_time"]` → Brave の `page_age`/`age` → `null`。
- 更新日時: `meta[property="article:modified_time"]` → 公開日時と同じ値 → `null`。
- 正規URL: `link[rel="canonical"]` の `href` があればそれを外部URLとして採用し、無ければ fetch 時に実際に解決された URL（リダイレクト後）を使う。ブログの同一記事が別パスで重複登録されるのを防ぐため。
- サイト名: `meta[property="og:site_name"]` → ドメイン名。
- 著者: `meta[name="author"]` があれば使用。取れないブログが大半である前提で、無ければ空配列のままにする（`items.authors` は `text[]` で必須ではない）。

抽出したテキストは既存の `stripHtml` 相当の空白正規化を通し、`MIN_BODY_CHARS`（例: 200文字）未満なら `skipped`（reason: `'body too short to review'`）とする。AIレビュー投入前に既存importer同様 `MAX_AI_BODY_CHARS`（4000）で切り詰める。

取得時の追加考慮:
- `Content-Type` が `text/html` を含まない場合（PDF・画像など）は fetch 直後にスキップする。
- `AbortController` で 10 秒タイムアウトを設定する（任意の外部サイトが応答しないケースに備える）。
- `User-Agent` はサービス名・目的が分かる文字列にする（例: `poke-research-blog-importer (+https://poke-research.com)`）。既存インポーターと同様、対象サイトへの配慮として同時実行数は抑えめにする（`IMPORT_CONCURRENCY = 2`、Zenn/note と同じ）。

## 4. 既存レコードとの差分検知によるAIレビュー省略

Qiita/Zenn/note は API 呼び出しコストが実質ゼロに近く、毎回 `reviewImportArticle`（OpenAI呼び出し）を再実行しても許容されている。Brave Search は無料枠のクエリ数上限があり、かつ任意サイトへの HTML fetch は API 呼び出しより重い。同じ記事を毎回再取得・再レビューする無駄を避けるため、このインポーターだけ差分検知を追加する。

- `items.version`（既存カラム、他インポーターは `updated_at` をそのまま入れている）に、抽出した本文テキストのハッシュ（例: `SHA-256` の先頭16桁）を version として保存する。
- 処理前に `external_url` で既存 `items.version` を1件 select し、今回計算したハッシュと一致すれば `reviewImportArticle` を呼ばずに `skipped`（reason: `'unchanged since last collection'`）として扱う。
- 一致しなければ通常通りAIレビュー→`upsertItemByExternalUrl` に進む（`version` は新しいハッシュで上書き）。
- この読み取りは `common.ts` に小さなヘルパー（例: `findItemVersionByExternalUrl(externalUrl): Promise<string | null>`）を追加して各インポーターから使えるようにする（Qiita/Zenn/noteは使わなくてよい。既存の動作は変えない）。

## 5. Source / Item マッピング

### Source（既知プラットフォーム単位、それ以外は共通「その他」）

検索対象サイトが個人ドメインを含め無数に存在しうるため、当初案の「ドメインごとに1レコード」は
`CatalogPage.astro` の「ソース」絞り込みチップ（`fetchCatalogSources()` で全件・無制限に列挙）を
埋め尽くしてしまう。そのため `src/lib/importers/keywords.ts` の `KNOWN_BLOG_PLATFORMS`
（はてなブログ、Speaker Deck、GitHub Pages 等の許可リスト）に載っているドメインはサービス単位
（ユーザーごとのサブドメインをまとめて1レコード、Qiita/Zenn/note と同じ発想）、載っていない
ドメインは共通の `OTHER_BLOG_SOURCE`（`その他`）にまとめる（`resolveBlogSource`）。

- `name`: 許可リストに一致すればそのプラットフォーム名（例: `はてなブログ`）、一致しなければ
  `その他`（個人ブログに限らず Stack Overflow・企業テックブログ等も混ざるため、ブログを冠しない名称にする）。
- `type`: `'blog'`（`sources.type` は自由文字列で、UI側に type 別の分岐ロジックは無いため追加のUI対応は不要 — `src/lib/catalog.ts` / `ItemCard.astro` 確認済み。`ItemCard.astro` の blog バッジ表示は `source.name` ではなく記事URLのドメインから直接算出しているため、source をサービス単位に集約してもカード上の表示は個別ドメインのまま保たれる）。
- `originUrl`: 許可リストに一致すれば `https://<プラットフォームのドメイン>/`、一致しなければ
  `OTHER_BLOG_SOURCE.originUrl`（`https://other-blogs.poke-research.invalid/`）。
  `upsertSourceByOriginUrl` の `origin_url` UNIQUE 制約でサービス単位／その他単位に収束させる。
- `metadata`: `{ service: 'blog', discovery: 'brave-search', collection: { query, fetched_at } }`
  を保存する（実行のたびに上書きされる点は既存と同じ。ドメイン単位の情報は集約後は一意で
  なくなるため source 側には持たず、記事ごとの hostname は `items.metadata.blog.hostname` に
  保持する）。

### Item

- `kind`: `'article'`。
- `externalUrl`: 正規URL（canonical、無ければリダイレクト解決後のURL）。
- `title` / `authors` / `summary`（AIレビューの `summary`）/ `publishedAt` / `updatedAt`: 上記抽出結果。
- `version`: 本文ハッシュ（上記4節）。
- `metadata`: 
  ```ts
  {
    service: 'blog',
    blog: { hostname, canonical_url, site_name, extraction_method: 'article' | 'main' | 'body' },
    provenance: {
      source: 'brave-search-importer',
      query,
      fetched_at,
      brave_rank: number,      // 検索結果内の順位（0始まり）。品質確認・デバッグ用
      brave_age: string | null,
    },
    ai: { model, accepted, reason, confidence, summary, tags },
  }
  ```
- タグ: `sourceTags` は無い（`[]` を渡す）ため、保存されるタグは実質 AI レビューが生成したものになる。既存の `existingTags` 再利用ロジック（表記ゆれ抑制）はそのまま効く。

## 6. API ルートと env 設定

`src/pages/api/import/blog.ts`（Qiita と同型）:

- `GET`: 解決済みデフォルト（query 一覧、count、offset、hasToken）を返す。
- `POST`: `{ query?, count?, offset? }` を受け付け、明示指定のみ上書き。既定クエリは `POKEMON_KEYWORDS` から組み立てるためコード管理のまま env には出さない（Qiita/Zenn/noteと同方針）。

`resolveBlogSyncOptions(env, overrides)` を `src/lib/importers/blog.ts` に用意し、他インポーターと同じ既定値解決パターンに揃える。

`.env.example` への追記:

```
# [任意] ブログ収集ジョブ（Brave Search API）の設定
BRAVE_API_KEY=your_brave_api_key_here
BRAVE_COUNT=20
```

## 7. Cron 追加

`wrangler.jsonc` の `triggers.crons` に4本目を追加し、`src/worker.ts` の `scheduled` ハンドラに `BLOG_CRON`（例: `'30 19 * * *'`, JST 翌04:30 — 既存の Qiita 18:00 / Zenn 18:30 / note 19:00 に続く時間帯）の分岐を足す。既存3件と同じく、記事単位の失敗は `syncBlogCollection` 内で吸収し、ジョブ全体を止める障害（Brave API 全断、Supabase未接続など）のみ `catch` してログに残す。

`scripts/collect/collect-blog.mjs` を既存の `collect-qiita.mjs` と同型で追加し、ローカルから手動起動できるようにする。

## 8. 運用上の考慮事項

- **Brave Search 無料枠の消費**: 1回の収集実行で使うクエリ数は `POKEMON_KEYWORDS`（現状2件）× 1リクエストが基本。ページ送り（`offset`）が必要になった場合も env の `BRAVE_COUNT`/追加オプションで明示制御し、cron の実行頻度（1日1回）を超えて無駄撃ちしない。
- **対象サイトへの配慮**: サイト全体のクロールはせず、Brave が返した個別記事URLのみを1回ずつ取得する。取得した生HTML・本文全文はDBに保存せず、AIレビュー結果（要約3行・タグ）のみを保存する点は既存インポーターと同じ。`robots.txt` の明示的な確認は今回のMVPには含めないが、サイト運営者から異議があった場合はドメイン単位で `EXCLUDED_BLOG_DOMAINS` に追加して除外できる設計にしておく。
- **抽出精度の限界**: `<article>` タグの有無やブログエンジンの実装差により、本文抽出は完全ではない。ノイズが多い抽出結果は AIレビューの `accepted: false` や低 `confidence` として自然に弾かれることを前提にし、抽出ロジック自体を過剰に作り込まない（既存の「本文が短すぎたらskip」で明らかな失敗は先に弾く）。

## 9. 未実装事項（このドキュメントは設計のみ）

- `src/lib/brave.ts`（Brave Search API クライアント）
- `src/lib/importers/keywords.ts` への `EXCLUDED_BLOG_DOMAINS` 追加
- `src/lib/importers/common.ts` への `findItemVersionByExternalUrl` 追加
- `src/lib/importers/blog.ts`（発見・汎用抽出・差分検知・AIレビュー連携の本体）
- `src/pages/api/import/blog.ts`
- `src/worker.ts` の `scheduled` への `BLOG_CRON` 分岐追加、`wrangler.jsonc` の `triggers.crons` 追加
- `scripts/collect/collect-blog.mjs`
- `.env.example` への `BRAVE_API_KEY` / `BRAVE_COUNT` 追記
- `docs/development-roadmap.md` M3 のBrave Search項目をこの設計の実装完了時に更新
