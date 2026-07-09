# 論文の掲載について

## 収集ソース
サービス	API	無料	実装優先度	用途
arXiv	○	○	★★★★★	AI・ゲームAIの最新プレプリント収集
OpenAlex	○	○（無料枠あり）	★★★★☆	査読論文を含む幅広い論文検索
Semantic Scholar	○	○	★★★☆☆	AI・CS系の補完、引用数・メタデータ取得
Crossref	○	○	★★★☆☆	DOI・出版情報の補完

まずはarXivだけで収集し、将来的にOpenAlex / Crossref なども使う。

## DBスキーマ
- `items.kind`に新値`paper`を入れて区別する（カラム・CHECK制約とも既存のまま追加変更不要）
- summaryは日本語で200字程度（技術記事の120字より多め）。`ai-review-prompt.mjs`の`buildSystemPrompt`をkind別に分岐させ、採否基準・要約文字数を出し分ける

## UI
- HOMEタブ : articleと一緒に表示
- 検索タブ : "技術記事"に改名し、articleだけ載せる（`catalog.ts`の`ItemFilters.kind`は実装済みで未使用だったものを活用）
- 論文タブを新設。論文だけ表示する以外は検索タブを流用する（`src/pages/papers/index.astro`等を新設し、`Layout.astro`のnavに手動でリンク追加）

## 収集品質
- ポケモンのデータでテストしただけで、内容そのものがポケモンを直接対象としていない論文がヒットすることが予想される。
- 収集クエリはキーワードのみで広く収集し、AIレビューを安全網にする方針（Brave収集・はてなブックマーク収集と同じパターン）。カテゴリ絞り込み（cs.AI等）の要否は、実装段階で実際のヒット率を見てから判断する。

## 未確認事項（実装前に要確認）
- arXivアブストラクト全文をsummary/bodyにどこまで転載してよいか、ライセンス・利用規約を確認する

## 実装状況（2026-07-09、`feat/paper-collection`）
収集パイプライン（`src/lib/importers/arxiv.ts` 等）とUI（`/papers`新設、検索タブ改名）を実装済み。
詳細は [docs/progress/2026-07-09.md](../progress/2026-07-09.md) を参照。

未着手・要判断:
- ~~**cron統合**: Cloudflareのcron trigger数上限（アカウント全体5件）に既存ジョブで達しているため、
  今回は手動API起動のみ。定期実行するにはスロット再配分の方針決めが必要。~~
  → その後、日次収集ジョブ群を単一Cron Trigger（`DAILY_CRON`）内の分単位スロットに束ねる方式へ
  変更済みで、arXivはcron統合済み（`src/worker.ts` の `DAILY_SLOT_JOBS`）。新規ジョブの追加も
  Cron Trigger登録の空き（現行3/5使用）かスロット追加のどちらかで対応でき、上限が支障になることはない。
- **タグクラウドのkind非対応**: `fetchTopTags` はDB RPC側で全kind横断集計のため、論文タブにも
  技術記事のタグが混ざる。データが増えてから改修要否を判断。
- 上記のライセンス確認は未実施のまま。

## 実装状況（2026-07-10、`feat/openalex-paper-import`）
OpenAlex Works API（`src/lib/importers/openalex.ts`、`src/lib/importers/openalex-parse.ts`、
`src/lib/openalex.ts`、`POST /api/import/openalex`）を実装。arxiv.ts と同じパターン
（広く収集してAIレビューを安全網にする方針、`items.kind='paper'`）を踏襲。

- **APIキーが必須化**: 計画時点（本ドキュメント冒頭表）の想定「無料枠あり」から変化しており、
  現在は無料アカウント作成＋APIキー取得（`openalex.org/settings/api`）が必要。無料キーで
  1日$1相当（フィルタ検索1万コール等）まで利用でき、本サイトの規模には十分。
- **アブストラクトは平文で提供されない**: `abstract_inverted_index`（単語→出現位置の逆インデックス）
  形式のみ。OpenAlexは出版社の権利関係を理由にこの形式にしていると明記しており、arXiv側の
  未確認事項（下記）と同種の論点だが、より踏み込んだ法的配慮が必要になりうる。今回は復元して
  body/AIレビュー入力に使う方針（arXivと同じ「本文はアブストラクト全文をそのまま保存」を踏襲）
  で実装したが、転載可否の確認自体は未実施のまま。
- **arXivとの重複対策**: OpenAlexのWork objectがarXivのアブストラクトページURLを含む場合、
  arxiv.ts と同じ正規化URLを `external_url` に採用することで、UNIQUE制約
  （`items.external_url`、migrations/002）を介して同一論文を別行にしない設計にした
  （`openalex-parse.ts` の `selectExternalUrl`）。実データ検証で、OpenAlexが同一論文を
  `primary_location=arxiv.org/abs/...`のWorkと`doi=10.48550/arxiv.<ID>`（arXiv自身の
  DOIプレフィックス）のWorkに分けて持つ場合があると判明したため、DOIの方も検出対象に含めている。
- **cron未統合**: まず手動起動（`POST /api/import/openalex`）で収集内容を確認してから、
  `worker.ts` の `DAILY_SLOT_JOBS` へのスロット追加要否を判断する。
- **実動作確認済み（2026-07-10）**: ローカルDev環境で `POST /api/import/openalex` を実行し、
  AIレビュー→保存、アブストラクト復元、arXiv重複回避（上記のDOIケース含む）が期待通り動作する
  ことを確認済み。詳細は [docs/progress/2026-07-10.md](../progress/2026-07-10.md) を参照。