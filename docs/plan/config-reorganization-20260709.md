# 設定ファイル整理プラン（2026-07-09時点の棚卸し）

「トピックによらない再利用性」を持たせる設計（別トピックへ再配布する際に書き換える箇所を一箇所に集める）を進めてきたが、該当箇所が増えるにつれて置き場所が分散し始めている。現状を棚卸しし、整理の選択肢を挙げる。

## 現状: 4箇所に分散している

1. **`src/config/topic.config.mjs`** — トピック固有データ本体（サイト名、収集キーワード、AIレビュー用語彙など）。約30ファイルから `import { topic } from '...topic.config.mjs'` で参照されており、一元化そのものはできている。
2. **`src/config/ai-review-prompt.mjs`** — AIレビューのsystem promptを組み立てる関数。ファイル冒頭のコメントに明記されている通り、判定ロジックの日本語文章自体はトピックに依らず再利用でき、`topic.config.mjs` の値をテンプレートの穴に差し込むだけの設計。つまり中身は「ロジック」であって「データ」ではないが、`src/config/` 直下に置かれているため、`topic.config.mjs` と同格の「書き換え対象」に見えてしまう。
3. **`src/lib/importers/keywords.ts`** — 前半（`POKEMON_KEYWORDS`/`BLOG_KEYWORDS`/`ZENN_TOPICS`）は `topic.config.mjs` の値をそのまま再エクスポートする窓口だが、後半（`EXCLUDED_BLOG_DOMAINS` のコア部分・`FILTERED_BLOG_DOMAINS`・`KNOWN_BLOG_PLATFORMS`・`OTHER_BLOG_SOURCE`）はトピックに依らない収集基盤側の共通定数で、`topic.collection.extraExcludedBlogDomains`（トピック固有の追加除外ドメイン）とマージされる形で同居している。1ファイルの中で「トピックごとに変わる値の窓口」と「変わらない共通定数」が混ざっている。
4. **`src/config/` の外にある、再配布時に手動で書き換える非JS資産** — `package.json`/`wrangler.jsonc` の `name`、`public/favicon.svg`・`og-image.png/svg`、README。これらはJS/mjsではないため `topic.config.mjs` を直接importできず、構造的に別管理にならざるを得ない。現状、この一覧の唯一の道しるべは `topic.config.mjs` 冒頭のコメント1行のみで、ドキュメント化されていない。
5. **`.env`/`.env.production`/`.env.example`** — 秘密情報（`OPENAI_API_KEY`/`BRAVE_API_KEY`/DB接続情報/管理者Basic認証）とジョブごとのチューニング値（`QIITA_PAGES`等）。Node の `--env-file` と Cloudflare の `env` バインディングという、`topic.config.mjs`のimportとは別の経路で読まれる。加えて `src/lib/openai.ts` と `src/lib/brave.ts` が「Cloudflare env と process.env の両方から読む」処理を、`brave.ts` 側のコメントに「`openai.ts`と同じ形で」と明記した上でほぼそのまま複製している。トピックを変えても書き換える必要がない値だが、読み込みロジックが2箇所に分散している。

## 問題点

- `src/config/` という名前のディレクトリに「データ」（topic.config.mjs）と「ロジック」（ai-review-prompt.mjs）が混在し始めており、「config/ 配下 = 再配布時に触る場所」という前提が崩れつつある。
- `keywords.ts` が「トピック値の窓口」と「収集基盤の共通定数置き場」を兼ねており、新しいトピック固有の除外ドメインを足したい人がどちらを触ればよいか、ファイルを読まないと判断できない。
- 再配布チェックリスト（package.json/wrangler.jsonc/favicon/og-image/README）がコード中のコメント1行にしかなく、実際に再配布する際に見落としやすい。
- 環境変数の読み込み処理（Cloudflare env / process.env の両対応）が `openai.ts`・`brave.ts` の2箇所に複製されている。

## `src/config/` の役割の再定義

当初案では「`src/config/` = トピック固有データのみ」としていたが、`.env` の扱いを踏まえて次のように広げる:

**`src/config/` = このアプリが外部（トピック値・環境変数）からどう設定されるかの窓口。** 「設定を読み込む・保持する」ものはここに集約し、「設定を消費して具体的な処理を行う」ロジックはここに置かない。

- `topic.config.mjs`（トピック固有データそのもの）→ 該当、現状維持
- `env.ts`（新規、環境変数読み込みの共通ヘルパー）→ 該当、新設
- `ai-review-prompt.mjs`（トピック値を消費してプロンプト文字列を組み立てるロジック）→ 非該当、`src/lib/` へ
- `keywords.ts` 後半の除外ドメインリスト・許可プラットフォームリスト（環境変数でもトピック値でもない、収集ロジック内部の参照データ）→ 非該当、`importers/keywords.ts` に残す

`.env`/`.env.production`/`.env.example` 自体（ファイルの実体）は `src/config/` へ移動しない。dotenvファイルは `--env-file` や `wrangler secret` が直接読む別経路であり、特に `.env`/`.env.production` は秘密情報を含むgitignore対象のため、コミットされる `src/config/` と物理的に混ぜると「コミットされる設定」と「されない秘密情報」の境界が曖昧になる。

## 現状維持でよい部分

- `topic.config.mjs` 自体の一元化（30ファイルからの参照）は機能しており、崩す理由がない。
- `keywords.ts` 前半の再エクスポート（`POKEMON_KEYWORDS` 等）はそのままでよい。トピック値を直接 `topic.config.mjs` から import させず、意味のある名前でラップする層として妥当。

## 提案（独立に採用可、優先度順）

### A. 再配布チェックリストのドキュメント化（工数: 小、効果: 高）— 実施時に前提を修正
**実施時に判明**: README.md には既に「他のトピックへ再配布する」節（topic.config.mjs編集→package.json/wrangler.jsonc name→favicon/og-image→build確認の4手順）が存在し、`topic.config.mjs` 冒頭のコメントもそこへの参照付きだった。「唯一の道しるべがコメント1行のみ」という当初の前提は誤りだったため、新規ドキュメントの新設は行わず、既存のREADMEの節に `.env`/`.env.production` は非トピック固有のため再配布時に書き換え不要である旨を1行追記するのみに留めた。

### B. `ai-review-prompt.mjs` を `src/config/` から移動（工数: 小、効果: 中）
中身が「トピック非依存のロジック」である以上、`src/config/` ではなく `src/lib/`（または `src/lib/importers/`、利用元が `article-ai.ts` と `retag-existing-items.mjs` のみのため）へ移動し、`src/config/` は「トピック固有データそのもの（= topic.config.mjs 一本）」専用と明文化する。import元3ファイル（`article-ai.ts`・`retag-existing-items.mjs`・呼び出し確認用のテスト等があれば）のパス修正のみで完結する。

### C. `keywords.ts` の境界を明示（工数: 小、効果: 中）
ファイルを分割するほどではないため、まずはファイル内にセクションコメントを追加し「ここから上: topic.config.mjs の値の窓口（トピックを変えたらここではなく topic.config.mjs を編集）」「ここから下: 収集基盤共通の定数（トピックに依らず変更不要）」と明示する。将来的にこのファイルがさらに肥大化するようなら、共通定数部分を `blog-platforms.ts` 等に分離する。

### D. 環境変数読み込みの共通化（工数: 小、効果: 中）
`src/lib/openai.ts` の `runtimeEnv`/`cloudflareEnv` 読み込み（Cloudflare env と process.env の両対応）を `src/config/env.ts` として切り出し、`openai.ts`・`brave.ts` の両方から使う共通ヘルパー（`readEnv(key)`）にする。`.env`/`.env.example` 自体は移動せず、あくまで「読み込み処理」だけを一本化する。

## 実施状況（2026-07-09）

A〜D すべて着手・完了した。

- **A**: 新規ドキュメントは作らず、README.md の既存の「他のトピックへ再配布する」節に `.env`/`.env.production` は再配布時に書き換え不要である旨を1行追記した。
- **B**: `src/config/ai-review-prompt.mjs` → `src/lib/importers/ai-review-prompt.mjs` へ移動。`article-ai.ts`・`scripts/db/retag-existing-items.mjs` のimportパスとコメント参照を追随させた。
- **C**: `src/lib/importers/keywords.ts` に「topic.config.mjsの値の窓口」区間と「収集基盤共通の定数」区間を分けるセクションコメントを追加した。
- **D**: `src/config/env.ts` を新設し、`readEnv(key)` ヘルパーに `openai.ts`・`brave.ts` の重複していた env 読み込みを統合した。

`npm run build` と `npm test`（106件）がいずれも成功することを確認済み。
