## Foundation

このリポジトリは、ポケモンプログラミング情報を収集・整理・検索する Astro + Supabase + Cloudflare ベースの情報ハブである。

作業前に [docs/development-roadmap.md](docs/development-roadmap.md) と最新の [docs/progress](docs/progress) を確認し、現在の優先度と進捗を把握する。

変更は最小限で、根本原因に対処する。既存の設計や命名、データモデル、API 形状をむやみに変えず、関連しない不具合の修正は混ぜない。

## Git

UI 関連の変更（Astro コンポーネント、レイアウト、スタイルなど見た目の調整）は `main` への直接コミットでよい。それ以外で実行に関わる変更（`src/lib` のロジック、`migrations/`、`wrangler.jsonc`、`package.json`、`scripts/` など）は、`main` から作業用ブランチ（`<type>/<topic>`、`type` はコミットと同じ `feat`/`fix`/`docs`/`chore`/`refactor` 等）または git worktree を切って行う。`docs/` 配下や進捗ログなど、ビルド・デプロイに影響しない変更は `main` への直接コミットでよい。

作業がまとまったらブランチを push して `main` へのプルリクエストを作成し、CI（`.github/workflows/ci.yml` の `build`/`migrations`）が通ることを確認してからマージする。マイグレーションを含む変更は、マージ（＝`main` への push、Cloudflare の自動デプロイが起動する）より先に本番 Supabase へ適用する（[docs/reference/operations.md](docs/reference/operations.md) の手順に従う）。

マージ方法はブランチ内のコミットをそのまま残す通常のマージを基本とし、単一コミットで完結する小さな変更は Squash merge でもよい。マージ後はブランチを削除する。

`main` への push（PR のマージを含む）や本番 Supabase・Cloudflare への操作は、実行前に必ずユーザーに確認する。

## Development

AI エージェントの利用モデルは `.env` の `OPENAI_MODEL` で指定する。初期値は `gpt-5-nano` を使う。reasoning_effort は `OPENAI_REASONING_EFFORT` で指定し、初期値は `minimal`（分類・抽出タスクのため深い推論は不要という判断、docs/optimization/openai-production-config-review.md）。

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

`src/lib/importers/article-ai.ts`（実体は `src/lib/importers/ai-review-prompt.mjs` の `buildSystemPrompt()`）のプロンプトや要約基準を変更したら、全件反映の前にまず問題事例だけで少数再テストする。採用済み記事は `scripts/db/list-retag-targets.mjs --id=<id>` の出力を Claude Code が `buildSystemPrompt()` の基準（STEP1〜5）に沿って判定し、`scripts/db/apply-item-review.mjs --id=<id> --dry-run` で書き込み内容を確認できるが、棄却済み記事（`items.ai_accepted=false`）は同スクリプトの対象外（`ai_accepted=true` のみ取得する設計）のため、使い捨てスクリプト（読み取り専用、DB書き込みなし）で個別に再判定する。少数検証で意図通り判定が変わることを確認したうえで、既存記事全体への反映の要否を検討する（件数が多い場合はサブエージェントに分散して判定・書き込みさせる。判定・書き込みともOpenAI課金は発生しないが、本番DBへの書き込みのため実行前にユーザー確認）。

プロンプトやモデル（`OPENAI_MODEL`）を変えて少数再テストを行う実験は、1回実行するごとに結果を `docs/optimization/` 配下のドキュメントへ逐一記録する（チャットでの報告だけで済ませない）。まとめて後で書くのではなく、実験→記録→次の実験、を1サイクルとして繰り返す。

実験の記録には、accepted/rejected を問わず reason・confidence・language など判定の検証に必要な情報を必ず含める。過去に存在した `retag-existing-items.mjs`（現在は `list-retag-targets.mjs` / `apply-item-review.mjs` に置き換え済み）の accepted 分岐は元々 reason を出力していなかった（ログを見て「なぜ採用されたか」を後から追えない）バグがあったため、両分岐で reason/confidence を出力するよう修正した経緯がある。同種の使い捨て検証スクリプトを新たに書く場合も、判定結果は accepted の値に関わらず reason 等をログに残す。

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
