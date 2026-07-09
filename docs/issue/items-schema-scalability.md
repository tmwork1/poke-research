# itemsテーブルのスキーマ成長: 列継ぎ足しは長期運用に耐えるか

## 経緯

`ai_recheck_*`列（AIレビューの直近判定を`ai_accepted`とは別に常に上書き記録する仕組み、[docs/progress/2026-07-10.md](../progress/2026-07-10.md)参照）を`migrations/025`として追加する際、2つの疑問が持ち上がった。

1. 列名が長すぎるのではないか（当初案`ai_last_review_prompt_version`は29文字）。
2. `items`テーブルは初期スキーマ（12列）から今回で26列まで、機能追加のたびに`ALTER TABLE items ADD COLUMN`で継ぎ足されてきた。この「継ぎ足しパターン」は長期運用に耐えるのか、今回のAIレビュー監査用データは専用テーブル（`item_ai_reviews`等）に分離すべきではないか。

2点目について、サブエージェント（`model: "fable"`）にセカンドオピニオンを依頼した。以下はその要点。

## itemsテーブルの列追加履歴（参考）

初期スキーマ（`migrations/001`）: `id, source_id, external_url, kind, title, authors, summary, published_at, updated_at, metadata jsonb, version, created_at`（+ 当初の`search_vector`は`004`でtrigram検索へ移行し削除）。

その後、機能追加のたびに列が足されてきた:

| migration | 追加列 | 用途 |
|---|---|---|
| 013 | `bookmarks_count` | ブックマーク数のキャッシュ |
| 015 | `body` | 本文全文（検索対象を広げる） |
| 016 | `link_status` / `link_checked_at` / `link_broken_since` | リンク切れ検出（3列セット） |
| 018 | `ai_accepted` | AIレビューでの採否（公開可否フラグ） |
| 021 | `language` | AIが判定した記事本文の言語 |
| 024 | `collection_route` | 実際に発見した収集ジョブ |
| 025 | `ai_recheck_*`（6列） | 直近AIレビューの条件・結果（今回） |

## Fableの見解

### 1. 継ぎ足しパターンは技術的に全く問題ない水準

Postgresの列数上限は約1600で、600〜700件・日次数十件書き込みという規模では性能面でも何桁も余裕がある。26列は「広いテーブル」ですらない。

分割を検討すべき兆候は**列数そのものではなく**、以下のようなもの:

- **接頭辞クラスタが「1:Nになりたがっているか」**（`link_*`や`ai_recheck_*`のような列の集まりが、単一の現在値ではなく複数の履歴/バリエーションを持ちたくなった瞬間）
- **カーディナリティの変化**（「1 itemに1つの現在値」→「1 itemに複数」）
- **書き込み主体・頻度の分離**（例: リンクチェックが高頻度化し、items本体の読み取りと競合し始める）
- **NULLだらけの列群**（特定kindにしか意味を持たない列がkind別に増殖し始める）

現状、上記のいずれの兆候も出ていない。

### 2. 6列 vs 専用テーブルのトレードオフ

| 観点 | items直接列（採用） | 1:1サイドテーブル | 1:N履歴テーブル |
|---|---|---|---|
| 書き込みのアトミック性 | 単一upsertで原子的 | items更新とレビュー行upsertが2往復・非原子的（supabase-jsはマルチステートメントtx不可） | 同左＋INSERT |
| 監査クエリ | 単純なWHERE一つ | JOIN1つ、PostgRESTなら埋め込みで書けるがやや冗長 | `DISTINCT ON`/lateral joinが必須、PostgRESTでは素直に表現できずビューが要る |
| 履歴の保持 | 不可（上書き） | 不可 | 可能 |
| コード変更量 | 実装済み | upsert経路の分割が必要 | 同左＋最新値取得の抽象化 |

今回の実際の要件は「直近レビューが現行プロンプト基準とズレているitemをSQLで抽出できること」であり、**履歴の保持そのものは要件にない**。履歴テーブルはその保険だが、保険料（非原子的書き込み、PostgRESTでの最新値取得の面倒さ）を今日から払うことになる。一方、先送りのコストはほぼゼロ（将来必要になったら`INSERT INTO item_ai_reviews SELECT ... FROM items`で現在値を初期履歴として移せる）。

実運用上の補足: `findExistingExternalUrls`が既存URLをOpenAI課金節約のため事前スキップする設計上、既存itemへの再レビュー自体が稀（`retag-existing-items.mjs`実行時、またはURL正規化ズレでの再突入時のみ）。履歴テーブルを作っても行がほとんど溜まらず、監査の実運用は結局「プロンプト更新後にretagを回して`ai_recheck_*`を見る」フローになる。

### 3. 既存パターンとの一貫性

`link_status`/`link_checked_at`/`link_broken_since`（016番）は「外部ジョブが定期チェックし、最新状態だけをitemsに上書きキャッシュする」という、今回の6列と構造的に同型。`ai_accepted`・`language`・`bookmarks_count`も同じ「itemの現在状態の非正規化キャッシュ」ファミリー。今回だけ別テーブルに切り出すと、「itemの現在状態はitemsにある」という暗黙の規約が崩れ、以後の機能追加のたびに「列かテーブルか」を毎回議論することになる。

### 4. 将来分離する場合の叩き台（参考、今回は不採用）

```sql
CREATE TABLE item_ai_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id int NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  accepted boolean NOT NULL,
  model text NOT NULL,
  prompt_hash text,
  reason text,
  confidence real,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_ai_reviews_item_latest ON item_ai_reviews (item_id, reviewed_at DESC);
CREATE VIEW item_latest_ai_reviews AS
  SELECT DISTINCT ON (item_id) * FROM item_ai_reviews ORDER BY item_id, reviewed_at DESC;
```

1:1サイドテーブル案（同じ6属性を`item_id`単一PKの別テーブルに置くだけ）は、列名短縮以外のメリットがほぼ無い割にJOINと非原子性のコストを払うため、Fableは中途半端で非推奨と評価している。分けるなら履歴型まで行くべき。

## 決定

**`migrations/025`の「itemsへの直接列追加」方針を維持する。** 理由:

1. 現規模（600〜700件、日次数十件書き込み）では列数増加は性能・保守性いずれの観点でも問題にならない。
2. `link_status`系と構造的に同型で、既存の設計規約と一貫している。
3 . 実際の要件（プロンプトversionのズレ検出）に対して、直接列＋単純WHEREが最小コストで応える。履歴テーブルは要件が変わった時点（＝実際に複数バージョンの履歴を残したくなった時点）で移行すれば十分安価。

**再検討すべきタイミング**（将来これらが起きたら本ドキュメントを更新し、履歴テーブル移行を検討する）:

- AIレビューの履歴（1itemにつき複数バージョンの判定結果）を実際に参照したい要件が生まれたとき。
- リンクチェック・AIレビュー等の「定期チェック系」列群の書き込み頻度が上がり、items本体の読み取りホットパスと競合し始めたとき。
- 特定`kind`（例: 論文専用）にしか意味を持たない列がkind別に増殖し始めたとき。

## 列名について（決定）

Fableは当初「`last_`は落とせる（スカラー列は定義上『最新値』しか持てないため、`link_checked_at`が`link_last_checked_at`でないのと同じ理屈）」として`ai_review_*`への改名を提案した。しかしユーザーから「`last`を落とすと`items.metadata->'ai'`（公開中の内容と対になり凍結される詳細ログ）との意味の区別がつかなくなるのでは」という指摘があり、これは妥当な反論と判断した。

`link_status`系には「凍結された旧情報」という競合相手がおらず、単一の情報源しか無いため「last」は本当に冗長だった。一方、今回の列は`items.metadata->'ai'.*`（最初に採用された時点で凍結され、`shouldPreserveAcceptedItem`により以後更新されないことがある）と、意図的に食い違いうる**2つ目の情報源**であり、その食い違いこそが本ドキュメントの発端となったバグ（id=5のreasonが古いプロンプト基準のまま凍結）の本質だった。したがって「これは公開中の内容とは別に常に最新化される再チェック結果である」という区別を運ぶ修飾語は、単なる冗長語ではなく実質的な情報を持つ。

最終的に`ai_last_review_*`でも`ai_review_*`でもなく、**`ai_recheck_*`（`ai_recheck_accepted`/`ai_recheck_model`/`ai_recheck_prompt_hash`/`ai_recheck_reason`/`ai_recheck_confidence`/`ai_rechecked_at`）**を採用した。「last」より短く、かつ「これは（公開状態を左右しない）再チェックである」という意味をより明示的に運ぶ語として選んだ。

## 追記: 「公開中の判定」側もフラット列に昇格（ai_review_\*）

上記の議論のあと、ユーザーから「初回check時の条件がすべて`metadata`に押し込められていて、SQLで`ai_recheck_*`と比較できない構造になっていないか」という指摘があった。確認したところその通りで、`ai_recheck_*`は全てフラット列である一方、「今公開されている内容（summary/tags/ai_accepted）を生んだ判定」の`model`/`prompt_version`（後に`prompt_hash`へ改名、下記参照）/`reason`/`confidence`は`items.metadata->'ai'.*`というjsonbの中にしか無く、両者をSQLで比較するには`metadata->'ai'->>'prompt_version'`のようなjsonb抽出（型キャストが必要、インデックスも効かない）を片側だけに使う非対称な構造になっていた。

これは`ai_accepted`列（migrations/018）が`accepted`だけを`metadata.ai.accepted`から先んじてフラット列に昇格させていたのと同じ理由で対応すべき問題だったため、`model`/`prompt_version`/`reason`/`confidence`/`reviewed_at`も同様にフラット列へ昇格させた（`accepted`は`ai_accepted`列が既にその役割を担うため対象外、5列）。列名は`ai_review_*`（`ai_reviewed_at`含む）とし、`ai_accepted`/summary/tagsと同じタイミングでのみ更新する（`ai_recheck_*`のように常には更新しない）ことで、「公開中の判定」という意味を保つ。

これにより、当初の目的だった監査クエリが両側ともフラット列同士の比較になった:

```sql
SELECT * FROM items
WHERE ai_accepted AND ai_review_prompt_hash IS DISTINCT FROM ai_recheck_prompt_hash;
```

## 追記2: prompt_version → prompt_hash へ改名

この値の実体は system prompt 本文（`buildSystemPrompt`の出力）のSHA-256ハッシュであり、人為的に連番を振る「バージョン」ではない。`version`という語は「意図的に更新された世代番号」を連想させ、実際の実装（文面が1文字変わっただけでも別の値になる機械的なハッシュ）と合わないという判断で、`ai_review_prompt_version`/`ai_recheck_prompt_version`を`ai_review_prompt_hash`/`ai_recheck_prompt_hash`に改名した（`computePromptVersion`関数も`computePromptHash`に改名）。本ドキュメント中の`prompt_version`表記は、改名前の議論の記録としてそのまま残している箇所がある。

## 参照

- [docs/progress/2026-07-10.md](../progress/2026-07-10.md) — `ai_review_*`/`ai_recheck_*`列を追加するに至った経緯
- `migrations/016_add_link_status.sql` — 今回と構造的に同型の既存パターン（ただし「last」省略の理屈がそのまま転用できない点は上記参照）
- `migrations/025_add_items_ai_review_recheck_columns.sql`
