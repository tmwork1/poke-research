# GitHubリポジトリ収集（kind='repo'）の採否基準 初回検証

対象: `src/lib/importers/ai-review-prompt.mjs`（`buildSystemPrompt(topic, 'repo')`）、`src/lib/importers/github.ts`。

## 背景

GitHubリポジトリタブ新設（`docs/plan/repo.md`）にあたり、ローカルSupabase環境で実際にGitHub Search API→README取得→AIレビュー→DB保存のパイプラインが動くかを検証した。モデルは`OPENAI_MODEL`既定値`gpt-5-nano`、`OPENAI_REASONING_EFFORT`既定値`minimal`。

## 実験1（2026-07-23、`maxResults=5`）

検索クエリ`pokemon fork:false`の上位5件（スター数順）を処理。結果: **5件中0件採用**。

| リポジトリ | 採否 | confidence | reason |
|---|---|---|---|
| skydoves/Pokedex | エラー（JSON不備） | - | `OpenAI response missing summary` |
| pagefaultgames/pokerogue | エラー（JSON不備） | - | `OpenAI response missing summary` |
| PWhiddy/PokemonRedExperiments | false | 0.25 | 「STEP 1: README本文の主言語を確定するには本文の全文を確認する必要があるが、提供された断片だけでは...現状は判断保留の可能性。」 |
| simeydotme/pokemon-cards-css | false | 0.22 | 「STEP 2...STEP 3の判断で主題はポケモン直接関係と判断できるか不確定。...STEP 5に進むべきかは追加情報次第。」 |
| smogon/pokemon-showdown | false | 0.15 | 「STEP 1の言語判定を要件として実装していますが...本文から言語コードを確定するプロセスがこの入力からは不完全のため...保留の判断としてaccepted を false にしました。」 |

## 分析

5件全てで、モデルが**判定を下す代わりに「情報が断片的で確信が持てない」という自己言及的な迷いを reason に書いている**（confidence も0.15〜0.25と低い）。特にsmogon/pokemon-showdownは実際には英語READMEが明確に取得できている（`curl`で直接確認済み、`fetchReadme`自体は正常動作）にもかかわらず、モデルが「言語判定すら完了できない」と述べている。README取得自体は正常に機能しており、入力データ側の不備ではない。

STEP2以降の除外基準（README空・転送のみ／リンク集／チュートリアル写経／紹介のみ）は今回一度も理由として使われておらず、**STEP 1〜3のどこかでモデルが早期に迷って停止している**ことが特徴。article/paper分岐（同じgpt-5-nano・minimal設定）ではこの種の「迷い」が過去に報告されておらず、repo分岐のプロンプト文面固有の問題と考えられる。

### 仮説

1. `sharedIntro`が「記事収集前レビュー」「記事本文の主な言語」という**article前提の語彙**のまま流用されており、入力がREADME（リポジトリ）であることとの不整合が小型モデルの迷いを誘発している可能性（paper分岐は同じ語彙を流用しているが問題が報告されていないため、この仮説単独では説明しきれない）。
2. repo分岐のSTEP2〜4がarticleのSTEP2〜4より条件分岐が多く、gpt-5-nano（minimal reasoning）には文面が複雑すぎる可能性。
3. `sourceTags`にGitHubの`topics`をそのまま渡しているが、無関係なtopicsが混ざり判断を惑わせている可能性（未検証）。

## 未実施

- 上記仮説を切り分けるためのプロンプト修正・再テストは未実施（追加のOpenAI課金を伴うため、ユーザー確認のうえで実施する）。
- 2件のJSON不備（summary欠落）自体の生レスポンスは未取得（`processImportItem`が例外を握りつぶすため、DBに行が残らずログも残らない。再現するには一時的なデバッグログが必要）。
