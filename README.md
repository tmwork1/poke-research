# Astro Starter Kit: Basics

```sh
npm create astro@latest -- --template basics
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
│   └── favicon.svg
├── src
│   ├── assets
│   │   └── astro.svg
│   ├── components
│   │   └── Welcome.astro
│   ├── layouts
│   │   └── Layout.astro
│   └── pages
│       └── index.astro
└── package.json
```

To learn more about the folder structure of an Astro project, refer to [our guide on project structure](https://docs.astro.build/en/basics/project-structure/).

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

## Qiita 収集ジョブ

- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons`、既定は毎日 18:00 UTC = JST 翌 3:00）が `src/worker.ts` の `scheduled` ハンドラを起動し、`resolveQiitaSyncOptions` で環境変数（`QIITA_QUERY` など）の既定条件を解決して `syncQiitaCollection` を実行する。
- 手動で同じ処理を起動したい場合は、ローカルなら `npm run collect:qiita`、デプロイ後は `POST /api/import/qiita` を叩く。`sources.origin_url` / `items.external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。
- 失敗時: `wrangler tail` や Cloudflare ダッシュボードのログで `[cron:qiita] sync failed` を確認する。記事単位の失敗はバッチを止めずに `skipped` として結果に積まれるため、ログに出る全体失敗は Qiita API 全断や Supabase 未接続など致命的なケースのみ。復旧を確認したら、次回 cron を待つか上記の手動実行で同じ内容を再実行すればよい。

