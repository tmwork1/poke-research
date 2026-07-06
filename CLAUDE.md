## Foundation

このリポジトリは、ポケモンプログラミング情報を収集・整理・検索する Astro + Supabase + Cloudflare ベースの情報ハブである。

作業前に [docs/development-roadmap.md](docs/development-roadmap.md) と最新の [docs/progress](docs/progress) を確認し、現在の優先度と進捗を把握する。既存の実装方針は [AGENTS.md](AGENTS.md) と合わせて扱い、両者に矛盾が出ないようにする。

変更は最小限で、根本原因に対処する。既存の設計や命名、データモデル、API 形状をむやみに変えず、関連しない不具合の修正は混ぜない。

## Git

`src/`・`migrations/`・`wrangler.jsonc`・`package.json`・`scripts/` など実行に関わる変更は、`main` から作業用ブランチ（`<type>/<topic>`、`type` はコミットと同じ `feat`/`fix`/`docs`/`chore`/`refactor` 等）を切って行う。`docs/` 配下や進捗ログなど、ビルド・デプロイに影響しない変更は `main` への直接コミットでよい。

作業がまとまったらブランチを push して `main` へのプルリクエストを作成し、CI（`.github/workflows/ci.yml` の `build`/`migrations`）が通ることを確認してからマージする。マイグレーションを含む変更は、マージ（＝`main` への push、Cloudflare の自動デプロイが起動する）より先に本番 Supabase へ適用する（[docs/reference/operations.md](docs/reference/operations.md) の手順に従う）。

マージ方法はブランチ内のコミットをそのまま残す通常のマージを基本とし、単一コミットで完結する小さな変更は Squash merge でもよい。マージ後はブランチを削除する。

`main` への push（PR のマージを含む）や本番 Supabase・Cloudflare への操作は、実行前に必ずユーザーに確認する。

## Development

AI エージェントの利用モデルは `.env` の `OPENAI_MODEL` で指定する。初期値は `gpt-5-nano` を使う。

環境変数は `.env` に設定し、API key もそこに書く。`.env` はコミットしない。

Node.js は `package.json` の `engines` に合わせて `>=22.15.0` を使う。

When starting the dev server, use background mode:

```bash
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Validation

変更後は、その変更に最も近い検証を優先する。UI やアプリ全体に触れたら `npm run build`、DB やマイグレーションに触れたら `scripts/db/run-migrations.mjs` や `scripts/db/test-db.mjs` などの該当スクリプトを使う。

ドキュメント変更だけなら `git diff --check` で十分だが、コード変更を伴う場合は必ず実行可能な検証を 1 つ以上通す。

`scripts/` 配下のスクリプトを追加・削除・改名したら、[docs/reference/scripts.md](docs/reference/scripts.md) も同時に更新する。

`src/lib/importers/article-ai.ts` のプロンプトや要約基準を変更したら、既存記事への `scripts/db/retag-existing-items.mjs` 再適用の要否を検討する（OpenAI 課金が発生するため実行前にユーザー確認）。

## Progress

作業が終わったら、必要に応じて [docs/progress/YYYY-MM-DD.md](docs/progress) を更新し、何を変えたかと現在の状態が追えるようにする。

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
