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

## 実験2（2026-07-23、プロンプトに「断片でも必ず結論を出す」旨を追加、reasoning_effort=minimal維持）

実験1と同じ5件、DB非経由の使い捨てスクリプト（本番コードは無変更、検証専用の別プロンプト文字列で実行）で再テスト。`sharedIntro`のSTEP1直前に「body_excerptは本文そのもの、または抜粋であり、断片であることを理由に判定を保留しない」旨を追加。

結果: 5件中5件で言語判定の迷い（「断片だけでは判断できない」）は解消し、全件`language: en`を明確に返した。しかし**STEP3（主題判定）の「実データテスト」で新たに全件棄却**（例: smogon/pokemon-showdownも「具体的な実装focusが不十分」として却下）。STEP1の仮説は正しかったが、別の問題（STEP3の実データテストがrepoには厳しすぎる）が表面化した。

## 実験3（2026-07-23、実験2に加えSTEP3の実データテストを緩和）

STEP3から「実際の種族値・タイプ相性等の実データに基づくか」という厳格なテストを削除し、「リポジトリ自体が${label}の実装・提供を目的としているか」という主題該当性のみで判定するよう変更。同じ5件・reasoning_effort=minimalで再テスト。

結果: **改善せず、むしろ悪化**。STEPの参照関係で自己矛盾する応答（例: 「STEPを保留せずfalseに設定」と言いながら実質保留、STEP番号を取り違える）が発生し、pokerogueのlanguageが`xx`（前回`en`と判定していたのに変化）になるなど再現性も低下した。これは**プロンプト文言の問題ではなく、gpt-5-nano側がreasoning_effort=minimalではこの分岐数の判定を安定してこなせないこと**を示唆する。

## 実験4（2026-07-23、プロンプト無変更・reasoning_effortのみlowに変更）

本番の`buildSystemPrompt(topic, 'repo')`を一切変更せず、`reasoning_effort`だけを`low`にして同じ5件を再テスト。

結果: **5件中5件採用**。reason はSTEP参照に矛盾がなく一貫しており、confidenceも0.55〜0.75と実験1〜3より高い。summary・tagsも全件で正常に生成された（実験1で発生した「OpenAI response missing summary」のJSON不備エラーも再現しなかった）。

| リポジトリ | 採否 | confidence | tags |
|---|---|---|---|
| skydoves/Pokedex | true | 0.75 | kotlin, android, hilt, coroutines, flow |
| pagefaultgames/pokerogue | true | 0.75 | web-game, browser, fangame, roguelite, license-agpl |
| PWhiddy/PokemonRedExperiments | true | 0.55 | reinforcement-learning, openai-gym, pytorch, tensorboard, ffmpeg |
| simeydotme/pokemon-cards-css | true | 0.58 | css, svelte, transform, gradient, filter |
| smogon/pokemon-showdown | true | 0.75 | javascript, node.js, web-api, game-server, battle-simulation |

## 結論・対応

**根本原因はプロンプト文面ではなく、`OPENAI_REASONING_EFFORT`の既定値`minimal`がkind='repo'のREADMEレビュー（多段の条件判定）には力不足だったこと。** article/paperと同程度の分岐数のプロンプトだが、README特有の構造（コードブロック・バッジ・インストール手順などが混在し、記事本文ほど素直な自然言語ではない）が、最小の推論コストでの多段判定をより不安定にしていたと考えられる（実験2〜3で見られた自己矛盾・再現性低下がその傍証）。

対応として、`src/lib/importers/article-ai.ts`にkind='repo'のみreasoning_effortの下限を`low`に引き上げる処理を追加した（プロンプト文言は無変更、article/paperの挙動・課金にも影響しない）。実験2・3で試したプロンプト変更（body_excerptの断片性言及、STEP3の実データテスト緩和）は採用しない（効果が無い、またはむしろ悪化させたため）。

## 未実施

- 5件を超える規模でのreasoning_effort=lowの精度検証（誤採用が増えないかの確認）は未実施。実運用（cron）で収集される件数が増えた段階で、`ai_recheck_model`/`ai_recheck_reason`を見て再点検する。
