## Foundation

このリポジトリは、ポケモンプログラミング情報を収集・整理・検索する Astro + Supabase + Cloudflare ベースの情報ハブである。

作業前に [docs/development-roadmap.md](docs/development-roadmap.md) と最新の [docs/progress](docs/progress) を確認し、現在の優先度と進捗を把握する。既存の実装方針は [AGENTS.md](AGENTS.md) と合わせて扱い、両者に矛盾が出ないようにする。

変更は最小限で、根本原因に対処する。既存の設計や命名、データモデル、API 形状をむやみに変えず、関連しない不具合の修正は混ぜない。

## Development

AI エージェントの利用モデルは `.env` の `OPENAI_MODEL` で指定する。初期値は `gpt5-nano` を使う。

環境変数は `.env` に設定し、API key もそこに書く。`.env` はコミットしない。

Node.js は `package.json` の `engines` に合わせて `>=22.12.0` を使う。

When starting the dev server, use background mode:

```bash
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Validation

変更後は、その変更に最も近い検証を優先する。UI やアプリ全体に触れたら `npm run build`、DB やマイグレーションに触れたら `scripts/run-migrations.mjs` や `scripts/test-db.mjs` などの該当スクリプトを使う。

ドキュメント変更だけなら `git diff --check` で十分だが、コード変更を伴う場合は必ず実行可能な検証を 1 つ以上通す。

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
