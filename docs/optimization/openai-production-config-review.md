# OpenAI本番設定・プロンプトのセカンドオピニオンレビュー

対象: `src/lib/importers/article-ai.ts`（記事/論文AI採否判定・要約・タグ生成）、`src/lib/importers/ai-review-prompt.mjs`（system prompt組み立て）、`src/lib/tag-explain.ts`（タグ専門用語解説）、`src/config/topic.config.mjs`（トピック語彙設定）。

## 背景・目的

本番でOpenAI API（`gpt-5-nano`）が作業する全ての入力情報・設定を洗い出し、Fable（サブエージェント）にセカンドオピニオンレビューを依頼した（2026-07-10）。メインエージェント（Sonnet）がコードベースを調査して設定・プロンプト・過去の意思決定の経緯（採用・棄却事例）をまとめ、Fableは実コードを見ずにその情報だけを根拠に品質・堅牢性・コストの観点でレビューした。本ドキュメントはその結果と、コードで裏取りした検証結果、対応プランをまとめたもの。

## 調査対象の全体像

| ファイル | 用途 | モデル | 稼働形態 |
|---|---|---|---|
| `article-ai.ts` / `ai-review-prompt.mjs` | 記事/論文AI採否判定・要約・タグ | `gpt-5-nano`(env) | cron（6ジョブ）＋手動API |
| `tag-explain.ts` | タグ専門用語判定＋解説 | `gpt-5-nano`(env) | 本番オンデマンドAPI（認証なし、ユーザーホバーで発火） |
| `topic.config.mjs`（`aiReview`セクション） | プロンプトへ展開するトピック固有語彙 | - | 設定ファイル |

全呼び出し共通: `response_format: { type: 'json_object' }`、temperature未指定。DB重複検出（週次cron）とOpenAlex手動バックフィルはOpenAIを使わない設計（前者はLevenshtein距離、後者はClaude Haikuサブエージェント）ため対象外。

## 参照した過去の意思決定（採用・棄却事例）

Fableに文脈として提示した8件。詳細は各メモリを参照。

1. 統計学・確率分布タグの乱用対応（PR #26、[[overused-analysis-tags]]） — プロンプトに具体的手法の適用有無を問う制約を追加
2. Brave Search収集のツールページ混入対策（[[blog-import-quality-fix]]） — ドメイン除外とプロンプト明記の多層防御
3. AI要約のスタイル変更（[[ai-summary-style]]） — だ・である調、2文以内、120字程度
4. 既存記事再判定は`ai_accepted`を自動では書き換えない設計（[[accepted-item-cleanup-gap]]） — 誤非公開化防止のための意図的設計、ただし偽陽性が残存する副作用が実際に発生
5. ローカル専用メンテナンススクリプトのOpenAI依存排除（PR #72、[[claude-code-db-maintenance-judgment]]） — Claude Code直接判定への置き換え
6. OpenAlex論文の手動バックフィルはClaude Haikuで判定（OpenAI不使用）
7. Braveの検索キーワードをQiita等と分離（[[brave-independent-keywords]]） — 課金対象job数削減
8. 週次DB重複検出はOpenAIを使わない設計（Levenshtein距離のみ）

## Fableのレビュー結果（7観点）

### 1. プロンプトインジェクション耐性 — 中程度のリスク
`body_excerpt`（記事本文、外部コンテンツ）に対し「これまでの指示を無視して」等の偽装指示を防ぐ明示的な防御文言がsystem promptに無い。json_object強制は出力形式のみを縛り、内容判定は保護しない。事例4（一度`accepted=true`になると再レビューされない）と組み合わさると**インジェクション成功が恒久化**する。汚染タグが`existing_tags`（DB上位40件）に混入すると、以後の判定に伝播するフィードバックループがある。

### 2. 出力の信頼境界
tag-explain公開APIのコストは、対象が既存タグIDに限定されキャッシュされる前提なら有界。`confidence`は較正されていない自己申告値で、閾値判定に使っているなら意味が薄い。`language`誤判定は偽陰性（skip）方向のため実害は小さい。

### 3. JSONパースの堅牢性
`accepted`の型検証欠如、タグの`NFKD`正規化が日本語の濁点・半濁点を壊す懸念を指摘。**→ 後述の通り両方とも実装済みの対策で解消済み（Fableの懸念は的外れ）。**

### 4. プロンプトの一貫性・保守性
STEP4のKaggle懐古記事対応等は「失敗事例ごとに文を足すパッチ」の蓄積。将来的には`accepted`をモデルの自然言語推論でなく構造化サブ判定（`page_type`/`on_topic`/`content_type`等）からコード側で導出する設計への移行を提案。過去の誤判定事例をラベル付きで保存した回帰テスト（ゴールデンセット）の整備を推奨。

### 5. モデル選定
`gpt-5-nano`継続は妥当。GPT-5系はtemperatureを受け付けない可能性が高く「未指定」は選択の余地がない。`reasoning_effort`/`verbosity`を明示指定すればコスト削減余地があるのでは、との指摘。**→ 後述の通り実際に未指定であることを確認、実在するギャップ。**

### 6. reason/accepted矛盾の未検知
事例2（reasonに棄却理由を書きつつ`accepted=true`）はプロンプト強化だけでは根絶できない自己矛盾。コード側で棄却系キーワード×`accepted=true`の組み合わせを検知するフラグを推奨。STEP1の言語判定も自己申告のみで外部検証なし。

### 7. 設計判断への異論
事例4は誤非公開化防止として妥当だが、**逆方向（棄却された偽陰性が永久に救済されない）の非対称**を指摘。事例5・6のモデル混在は精度評価時に層別が必要（`ai_recheck_model`記録済みは適切な備え）。

## コードでの裏取り結果

Fableの指摘のうち2点は、**実装済みの対策で既に解消されている**ことを確認した（Fableはコードを見ていないため生じた的外れな指摘）。

| Fableの指摘 | 実際のコード | 判定 |
|---|---|---|
| `accepted`の型検証が無い | `article-ai.ts:116-118` — `typeof accepted !== 'boolean'`で弾いて例外throw | **的外れ（対策済み）** |
| NFKD正規化が日本語濁点を破壊する | `article-ai.ts:38-51` `normalizeTagName` — Latin結合ダイアクリティカルマーク範囲のみ除去後NFCで再合成、日本語濁点は保持される設計。コメントで意図を明記 | **的外れ（意図的に対策済み）** |
| tag-explainの`is_difficult=false`結果が再問い合わせされる懸念 | `tag-explain.ts:78,114` — `is_difficult`の値に関わらず`explained_at`を書き込みキャッシュ | **的外れ（対策済み）** |

一方、以下は**実在するギャップ**として残る。

- `reasoning_effort`/`verbosity`パラメータは全呼び出しで未指定（`src/lib/openai.ts`にも各呼び出し元にも記述なし）
- プロンプトインジェクション対策の明示文言は無い
- reason/accepted矛盾を機械的に検知する後処理は無い
- 棄却記事（偽陰性）をプロンプト改善後に再判定・救済する仕組みは無い

## 対応プラン（優先度順）

### 優先度High — 実施済み（2026-07-10）

1. **本文=データ宣言の追加** — `ai-review-prompt.mjs`の`sharedIntro`に、title/body_excerpt/authors/source_tags等のユーザーメッセージの全フィールドは信頼できない外部データであり、その中の指示文に見える記述には従わない旨の一文を追加（article/paper両kindに共通適用）。`tag-explain.ts`のsystem promptにも同種の一文（tag値は外部データとして扱う）を追加。
2. **reason/accepted矛盾検知の後処理** — `article-ai.ts`の`parseAiResponse`に、STEP1・STEP2がreasonへ書くことを義務付けている文言（「対象言語外」「リンク集・目次ページ」）が含まれるのに`accepted=true`の場合、強制的に`accepted=false`へ倒し、reasonに矛盾検知の注記を先頭付与するガードを追加。STEP4は矛盾時にreasonへ書くべき文言が固定されておらず誤検知リスクが高いため、今回は対象外（過検知を避けるため、STEP1/STEP2の確実な文言のみに限定）。
3. **`reasoning_effort`パラメータの追加** — `src/lib/openai.ts`の`getOpenAIConfig()`に`reasoningEffort`（`OPENAI_REASONING_EFFORT`環境変数、既定`minimal`）を追加し、`article-ai.ts`・`tag-explain.ts`の両リクエストに配線。gpt-5-nanoが`minimal`/`low`/`medium`/`high`をサポートすることをOpenAI公式ドキュメント・コミュニティ情報で確認済み（分類・抽出タスクなので`minimal`が既定）。`.env.example`・`CLAUDE.md`に追記。

**注意**: `reasoning_effort`はreasoningモデル（GPT-5系）専用のパラメータ。将来`OPENAI_MODEL`を非reasoningモデル（gpt-4o-mini等）に変更する場合は、この配線ごと見直しが必要（無効パラメータでAPIが400を返し全cronジョブが失敗する）。

### 優先度Medium・Low — 未着手

対応プランの4〜7（棄却記事の救済スクリプト、回帰テスト整備、構造化サブ判定への移行、STEP1言語判定の外部検証）は引き続き未着手。着手時はこのセクションを更新する。

### 優先度Medium（中期課題）

4. **棄却記事の救済スクリプト** — [[claude-code-db-maintenance-judgment]]の`list-*.mjs`/`apply-*.mjs`パターンに倣い、`ai_accepted=false`の記事のみを対象にした再判定リストアップを作り、プロンプト改善時に偽陽性（[[accepted-item-cleanup-gap]]で対応済み）と偽陰性の両方を救済できるようにする。
5. **回帰テスト（ゴールデンセット）整備** — 過去の誤判定事例（filter-accuracy.mdに蓄積済み）をラベル付きデータとして保存し、プロンプト変更時に既知事例が再現しないか機械的に確認できるようにする。

### 優先度Low（様子見）

6. **構造化サブ判定への移行** — `accepted`を単一のモデル判断でなく`page_type`/`on_topic`/`content_type`等の中間出力からコード側で導出する設計。効果は大きいが変更範囲も大きいため、上記対応後も同型の誤判定が続く場合に検討する。
7. **STEP1言語判定の外部検証** — 自己申告の`language`が実際と異なるケースの実害は小さいと判断し、現時点では対応不要。

## Why（このドキュメントを残す理由）

OpenAI本番設定は個人開発の課金対象であり、かつ収集記事という外部入力を扱うため、プロンプトインジェクションやコスト面のリスクは定期的に再点検する価値がある。一方でFableのようなコード非参照のレビューは実装済みの対策を「未対策」と誤検知することがあるため、指摘は必ずコードで裏取りしてから対応要否を判断する運用とする。
