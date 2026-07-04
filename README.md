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

## Zenn 収集ジョブ

- Zenn には公式 API が無いため、実際のサイトで使われている非公式エンドポイント（`/api/articles?topicname=`、`/api/articles/{slug}`）を利用している。仕様変更で壊れる可能性がある点に留意する。
- 収集条件はキーワードではなく `topic`（Zenn のトピックスラッグ、既定は `pokemon`）で絞り込む。Zenn の記事一覧 API はキーワード全文検索に対応していないため。
- 本番では Cloudflare Cron Triggers（`wrangler.jsonc` の `triggers.crons` に Qiita とは別枠で追加、既定は毎日 18:30 UTC = JST 翌 3:30）が `src/worker.ts` の `scheduled` ハンドラを起動する。`controller.cron` の値で Qiita/Zenn どちらのジョブかを振り分けている。
- 手動で起動したい場合は、ローカルなら `npm run collect:zenn`、デプロイ後は `POST /api/import/zenn` を叩く。Qiita と同様に `external_url` の UNIQUE 制約に基づく upsert なので、何度実行しても重複行は増えない（冪等）。
- 失敗時: `wrangler tail` などで `[cron:zenn] sync failed` を確認する。記事単位（詳細取得・AI レビュー・DB 書き込みのいずれか）の失敗は `skipped` に吸収されるため、ジョブ全体が落ちるのは Zenn 側の仕様変更やレート制限など致命的なケースのみ。復旧を確認したら、次回 cron を待つか手動実行で再実行すればよい。

