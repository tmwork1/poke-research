# arXiv論文収集（kind='paper'）の採否基準（STEP2主題判定）見直し

対象: `src/lib/importers/ai-review-prompt.mjs`（`buildSystemPrompt(topic, 'paper')`）、`src/lib/importers/arxiv.ts`。

## 背景・目的

「arXivのヒット件数が少ない。採用範囲を『ポケモンに応用・適用しているコンピュータサイエンス』と広げたら有効か」という相談で着手。作業は `git worktree`（`feat/arxiv-paper-topic-scope`）上で実施した。

## 現状把握（実データでの分析）

累計収集75件、採用20件（27%）・棄却55件（73%）。棄却55件全件を本文（アブストラクト）付きでレビューした。

- 大半（天文学の"POKEMON Speckle Survey"複数件、物理の"Protected Logic Qubit"論文、頭字語衝突、Pokémon GOを題材にした公衆衛生・都市モビリティ・COVID影響等の社会科学論文、他ゲームと並ぶ一例としてPokémonに言及するだけのRLベンチマーク論文）は、当時のSTEP2（「論文全体を通じて主要な研究対象として扱っているか」）でも妥当な棄却だった。
- 採用20件の中に、AIが一度棄却したものを**人間が手動でoverride**した事例が2件あった:
  - PokéChamp（汎用minimaxフレームワークだがPokémon対戦のみで検証）
  - PokeGym（汎用VLMベンチマーク手法だがPokemon Legends: Z-Aのみを実験環境として使用）
  - override理由: 「単一のポケモン環境を主要な検証基盤とする研究と判断」
- この「実験・検証で使用した環境がPokemon単独か、複数ゲームの一つに過ぎないか」という基準を棄却済み55件に当てはめ直すと、同じパターンなのに棄却されたままの論文が2件見つかった:
  - **Continual Harness**（Gemini Plays Pokemon実験。Pokemon Blue/Yellow Legacy/Crystal/Red/Emeraldのみ、他ゲーム無し）
  - **Game Agent Driven by Free-Form Text Command**（JSAI論文。検証環境は「ポケモンを模したゲーム環境」のみ）
- 逆に、複数環境で評価している論文（ASH: Pokemon Emerald+Zelda Minish Cap、All by Myself: Pokemon+Chef's Hat、Automatic Generation of High-Performance RL Environments: 8環境）は妥当に棄却されており、「単一環境か」という基準の判別力は裏付けられた。

### 検索クエリ側（recallチェック）

`npm run eval:recall -- --source=arxiv` を実行（Brave Searchで独立に候補を探しDB未収録分を突き合わせる）。候補85件中68件がDB未収録だったが、大半はBrave検索の緩いマッチによるノイズ（"pokeapi"に対し無関係語"PoPPy"/"POPI"/"Poppy"等がヒットする）だった。実質的な取りこぼしは1件のみ:

- **"Gotta Assess 'Em All: A Risk Analysis of Criminal Offenses Facilitated through PokemonGO"**（arXiv:2304.02952）。スペース無し複合語"PokemonGO"がarXivの`all:pokemon`のトークン検索でヒットしていない（アクセント記号folding問題と同種のトークナイズ起因の取りこぼし）。

→ 件数不足の主因は検索クエリではなく採否基準側と判断。ただし低コストで直せる実例が見つかったのでクエリも修正した。

## 判断: 包括的拡大ではなく基準の精緻化

「ポケモンに応用・適用しているCS」への包括的拡大は不採用。ASHや8環境ベンチマーク論文のような、Pokemonを多数の評価環境の一つとして使うだけの一般的RL/ゲームAI論文まで採用してしまい、ハブの焦点が薄まるため。

代わりに、STEP2を「論文の主眼が何か」という小型モデル（gpt-5-nano）には曖昧な基準から、人間の手動override実績（PokéChamp・PokeGym）が示す「実験で使用した環境を列挙し、Pokemon以外が1つでも含まれれば主題外」という機械的に判定しやすい基準に差し替えた。ただし単純な単一環境基準だけに置き換えると、Pokémon GO社会科学論文（実験環境はPokémon GO単独）まで採用されてしまうため、「計算機科学的に扱っているか、それとも実世界の社会現象として社会科学的に分析しているだけか」という主題ゲートは維持し、2条件のANDとした（fableサブエージェントによるセカンドオピニオンで指摘）。

## プロンプト修正（`ai-review-prompt.mjs`, STEP2 paper分岐）

修正前:
> 主題が{label}関連であっても、論文全体を通じて{label}のデータ・環境・ゲーム内容を主要な研究対象として扱っているかを確認してください。強化学習のベンチマークなど、他のゲーム・環境と並ぶ一例として{label}に言及しているだけで、論文の主眼が{label}以外の一般的な手法・環境評価にある論文は主題外とみなし、accepted を false にしてください。

修正後（2段階、環境列挙を先に強制）:
> まず、論文の実験・評価で使用したゲーム／環境をすべて列挙してください。列挙した中に{label}以外のゲーム／環境が1つでも含まれる場合は、{label}への言及や部分的な使用があっても主題外とみなし、以降の判定に関わらず accepted を false にしてください（〜環境の総数が多い論文ほど見落としやすいため、必ず全環境を数え上げてから判定してください）。{label}のみを使用している場合は、次に、論文が{label}のデータ・仕組み・ゲームプレイを計算機科学的に扱っているのか、それとも{label}を実世界の社会現象として統計的・社会科学的に分析しているだけなのかを判定してください。後者の場合も主題外とみなし、accepted を false にしてください。

## クエリ修正（`arxiv.ts`）

`ARXIV_ACCENTED_VARIANTS`（pokemon→pokémonのみ）を`ARXIV_KEYWORD_VARIANTS`に一般化し、`pokemongo`を追加。`all:pokemon OR all:pokémon OR all:pokemongo OR ...` となる。

## 検証（少数再テスト、DB書き込みなし・OpenAI `gpt-5-nano` 実呼び出し）

`retag-existing-items.mjs` は `ai_accepted=true` の記事のみが対象で棄却済み記事を拾えないため（CLAUDE.md記載の理由）、使い捨てスクリプト（読み取り専用、検証後に削除済み）で9件を個別に再判定した。

### 1回目（環境列挙とCS/社会科学の順序を入れ替える前、単純に2条件を並記しただけの版）

| タイトル | 期待 | 結果 |
|---|---|---|
| Continual Harness | true | ✅ true |
| Game Agent (JSAI) | true | ✅ true |
| PokéChamp | true | ✅ true（手動override無しでAI自動判定） |
| PokeGym | true | ✅ true（同上） |
| Human-Level Competitive Pokémon（回帰確認） | true | ✅ true |
| ASH | false | ✅ false |
| All by Myself | false | ✅ false |
| Pokémon Go都市モビリティ論文（社会科学、回帰リスク） | false | ✅ false |
| Automatic Generation of High-Performance RL Environments（8環境） | false | ❌ **true**（不一致） |

8/9一致。狙った4件（Continual Harness, JSAI論文, PokéChamp, PokeGym）はすべて意図通りtrueに反転し、社会科学論文の回帰も回避できた。ただし8環境を横断評価する論文が誤ってtrueになった。「CS的に扱っているか」の判定は通ったが、「複数環境の一つに過ぎないか」のチェックが事実上スキップされていた。

### 2回目（環境列挙を最初の必須ステップとして強制する版、上記「プロンプト修正」の最終形）

全9件が期待通り（9/9）。8環境論文も reason で `PyBoy（Game Boyエミュレータ）などポケモン以外の環境が含まれているため主題外` と明示的に環境を列挙したうえで正しく棄却された。

## 結果まとめ・今後

- 今回の修正で拾えるのは棄却済み55件中2〜4件程度（Continual Harness, JSAI論文、および今後収集される同パターンの論文）で、arXiv上のPokemon主対象CS論文自体が少ないという根本要因は変わらない。件数の大幅な改善というより精度改善の位置づけ。
- 既存の棄却済み55件への遡及適用は、`retag-existing-items.mjs`が対象外（ai_accepted=falseのため）なので、必要なら別途使い捨てスクリプトでの再判定を検討する（未実施）。
- `npm test`（111件）・`npm run build` green。
