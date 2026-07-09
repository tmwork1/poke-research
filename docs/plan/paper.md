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
- **cron統合**: Cloudflareのcron trigger数上限（アカウント全体5件）に既存ジョブで達しているため、
  今回は手動API起動のみ。定期実行するにはスロット再配分の方針決めが必要。
- **タグクラウドのkind非対応**: `fetchTopTags` はDB RPC側で全kind横断集計のため、論文タブにも
  技術記事のタグが混ざる。データが増えてから改修要否を判断。
- 上記のライセンス確認は未実施のまま。