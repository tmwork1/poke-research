# GitHubリポジトリの掲載について

## 経緯

`docs/development-roadmap.md`（M3）には当初「GitHub（リポジトリ）は対象外とする。閲覧者にとって記事よりリポジトリは読むハードルが高く、この情報ハブの想定読者に合わないため」という方針があったが、2026-07-22にユーザー判断でこの方針を撤回し、記事・論文に続く3つ目のタブとして新設する（YouTube対象外の方針は変更しない）。

## 収集ソース

GitHub REST API の Search repositories エンドポイント（`GET /search/repositories`）のみを使う。

- 認証: `GITHUB_TOKEN`（スコープ不要のPersonal Access Token）を必須にする。未認証だと検索APIが10req/min、README取得を含むcore APIが60req/hrしかなく、候補ごとのREADME取得を伴う実運用に耐えない。
- クエリ: `POKEMON_KEYWORDS`（`topic.config.mjs`の`collection.searchKeywords`）のうち英数字のみのキーワード（現状`pokemon`のみ、arXiv/OpenAlexと同じ絞り込み）を使う。
- ソート: `sort=stars&order=desc`。記事・論文の新着順とは異なり、リポジトリは玉石混交になりやすいため人気（スター数）順で質の高い実装を優先する方針にした。
- フォーク除外: `fork:false`をクエリに含め、検索時点で機械的に除外する（AIレビューにフォーク判定を持たせない。安価かつ確実なため）。`repo.fork`の値自体は`items.metadata.github.is_fork`に記録し、万一効かなかった場合の事後監査に備える。

### `in:readme`修飾子は使わない（実機検証済み）

当初、README本文中の言及も検索対象にするため`in:name,description,readme`を検討したが、実機検証（`curl`でGitHub Search APIを直接叩いて確認）の結果、**`in:`修飾子に`readme`を含めると検索クエリ自体が壊れる**ことを確認した。

- `pokemon in:name,description` → 期待通りポケモン関連リポジトリがヒットする
- `pokemon in:name,description,readme`（または`in:readme`単体） → `pokemon`という検索語が無視されたかのように、`sindresorhus/awesome`や`public-apis/public-apis`など無関係な人気リポジトリがヒットする

このため`in:`修飾子は使わず、デフォルトの検索対象（リポジトリ名・説明文・トピックス）に任せる方針にした。README全文検索ができない分、発見段階での取りこぼしが発生しうるが、収集後に別途README本文を取得しAIレビューの入力に使うため、発見clientのクエリ設計としては許容する。

### 複数キーワードのOR結合構文は未検証

キーワードが複数ある場合の`(a OR b) fork:false`という括弧+OR結合構文は、GitHubのrepository検索で仕様通り機能するか実機未検証（現状キーワードは`pokemon`1語のみのため発生しない）。将来キーワードを増やす場合は、先にcurlで検証し、機能しなければ`hatena.ts`と同じ「キーワードごとに個別fetch→クライアント側でマージ・重複排除」方式へのフォールバックを検討する。

## DBスキーマ

マイグレーション不要。`items.kind`は自由文字列（CHECK制約なし）のため、新値`'repo'`を追加するだけで良い。

- GitHub固有メタデータ（stars, forks, is_fork, primary_language, topics, archived, pushed_at）は`items.metadata.github`（jsonb）に格納する。
- `items.language`は既存の意味（README本文のISO639-1自然言語コード、AIレビューが判定）のまま流用し、GitHubのプログラミング言語（Python/JS等）とは混同しない（後者は`metadata.github.primary_language`）。
- `authors`にはリポジトリのowner loginを1件入れる（カード表示のbylineに流用）。
- `sources`テーブルに`type='github'`の単一ソース行（arXiv/OpenAlexと同じ「メタソース1行」方式）。

## AIレビュー

`src/lib/importers/ai-review-prompt.mjs`の`buildSystemPrompt`に`kind==='repo'`分岐を追加した。

- STEP1（言語判定）は共有のまま流用。
- STEP2: README本文がほぼ空・他プロジェクトへの転送のみの軽量除外（フォーク判定は検索クエリ側で済んでいるため不要）。
- STEP3: articleのSTEP3（実データ・実仕様に基づくかのテスト）をREADME向けに読み替えて流用。
- STEP4: リポジトリ特有の除外基準（リンク集/awesome-list、チュートリアル写経、紹介のみ）。
- 要約は記事と同水準（120字程度）を初期値とした。READMEは記事本文より情報量が少ないケースが多いため、実データ収集後に短縮要否を判断する。

## UI

- HOMEタブ: 記事・論文と同様、`kind`フィルタを持たないため自動的に混在表示される（論文導入時の前例と同じ）。
- 検索タブ: `/repos`を新設。論文タブ（`/papers`）と同じ構成で、`CatalogPage.astro`をそのまま流用する。
- `Layout.astro`のnavに「リポジトリ」タブを追加。
- `ItemCard.astro`に`data-source-type='github'`用の配色を追加。

## 収集品質・運用

- cronは新規Cron Trigger登録を使わず、既存の日次収集ジョブ群（`DAILY_CRON`）に分35のスロットを追加する形で統合した（arXiv/OpenAlexと同じ方式）。
- 手動起動用API: `POST /api/import/github`（`scripts/collect/collect-github.mjs`からも起動可能）。

## 未確認事項（実装後に要確認）

- README全文の転載可否（ライセンス・利用規約）は、arXiv/OpenAlexの未確認事項と同様、実施していない。
- 複数キーワードのOR結合構文の実機検証（キーワードを増やす場合に必要）。
- `maxNewItemsPerRun`の初期値（10件）はarXiv/OpenAlexの見積りにREADME取得分の+1 subrequestを加えた保守的な値で、実測後に調整が必要な場合がある。

## 実装状況（2026-07-23、実データ検証）

ローカルSupabase環境で`POST /api/import/github`を実行し、GitHub Search API検索→README取得→AIレビュー→DB保存のパイプラインが技術的には一通り動作することを確認した（詳細は [docs/progress/2026-07-23.md](../progress/2026-07-23.md) 参照）。

一方、AIの採否判断（`kind='repo'`のSTEP2〜4）は5件中0件採用で、モデルが判断を下さず迷うreasonを返す傾向が見られた。要約文字数（120字）の妥当性検証を含め、プロンプトの見直しは [docs/optimization/github-repo-filter-accuracy.md](../optimization/github-repo-filter-accuracy.md) に記録し、後日の課題とした。
