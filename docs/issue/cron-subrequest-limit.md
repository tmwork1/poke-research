# 日次cronがCloudflare Workersのsubrequest数上限と衝突する問題

- **発覚日**: 2026-07-09
- **状態**: 解決済み。差分検知・バッチ化（ブランチ`fix/cron-subrequest-diff-detection`）に加え、
  候補5（日次収集バンドルの分割）も実施した。フィード/Qiita/Zenn/arXiv/はてなの5ジョブを
  単一Cron Trigger文字列 `"0,5,10,15,20 0 * * *"` 内で発火時刻ごとに1ジョブずつ実行する時間分割へ
  移行し（順序は記事の無駄な重複が少なくなるよう決定）、日次まとめ通知は専用cron
  （`"40 0 * * *"`）からDBを直接集計する方式に変更した。詳細・全体像は
  [docs/scheduled-jobs.md](../scheduled-jobs.md) を参照。
- **関連PR**: #36（日次通知の集約）、#37（動作確認用の一時cron変更）、#39（09:00へ復旧）、
  #45（日次収集の時間分割・まとめ通知のDB集計化）

## 問題

日次収集ジョブ群（フィード/Qiita/Zenn/Blog/リンク切れ検出/はてなブックマーク/arXivの7ジョブ、
noteは403エラーのため対象外）は、Cloudflareアカウント全体のcron trigger数上限（現行プランで5件）
を回避するため、**1回のWorker呼び出しに集約し`src/worker.ts`の`scheduled`ハンドラ内で順次実行する**
設計になっている（arXiv追加時に導入。経緯は[docs/progress/2026-07-09.md](../progress/2026-07-09.md)
「cronへのarXiv組み込み・noteの自動実行停止」を参照）。

この設計は、Cloudflare Workersの**「1回のWorker呼び出しあたりのsubrequest（外部fetch呼び出し）
数上限」**（無料/標準プランの目安は50件/呼び出し）と衝突する。各ジョブは候補記事1件ごとに
OpenAIレビュー呼び出し＋Supabaseへの複数回の読み書きを行うため、subrequestが7ジョブ分累積し、
早いジョブ（Qiitaなど）の時点で上限に達すると、**同一呼び出し内の後続ジョブ全てが巻き添えで
失敗する**。`import_runs`への実行記録自体もSupabase呼び出し（＝subrequest）のため、上限到達後は
失敗の記録すら書き込めず、外部からは「cronが何もせず終わった」ようにしか見えない。

## 発見の経緯

PR #36（日次収集Discord通知の集約・0件でも送信するよう変更）が実際のCloudflare Cron Triggerで
正しく動くかを確認するため、日次cronの発火時刻を一時的に`0 0 * * *`（JST 09:00）から
`15 1 * * *`（JST 10:15）に変更して本番で観察した（PR #37）。

- 10:15 JSTにcronは正常に発火し、1番目のジョブ（フィード）は成功して`import_runs`に記録された。
- 2番目のQiitaジョブ以降、`import_runs`に何も記録されず、Discordへの日次サマリ通知
  （PR #36の新機能）も一切届かなかった。10分待っても状況は変わらなかった。
- 同じ`POST /api/import/qiita`を本番へ手動で直接叩いて再現を確認。`curl --max-time 480`
  （8分の余裕を持たせたクライアント）で待ったところ、約160秒後にHTTP 201で応答した。
  ハング（無限に応答が返らない）ではなく、大幅な遅延と大量のエラーが発生していたことが判明。
- レスポンス本文に明確な原因が含まれていた:
  ```
  "reason": "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits"
  ```
  Qiitaの候補記事20件を処理する過程でsubrequestが積み上がり、上限へ到達していた。
- cron発火時に何も記録されなかった理由: `import_runs`への記録処理自体もsubrequestであるため、
  上限到達後はその記録すら書き込めない。一方、手動APIでの単体呼び出しは新しい呼び出しとして
  subrequest予算がリセットされるため、Qiita単体では（大量のエラーを出しつつも）最終的に完了できた。

## 影響範囲

日次収集7ジョブを1回のWorker呼び出しに集約する設計が導入されて以降（PR #34、2026-07-09マージ）、
断続的にQiita以降のジョブが実行されていなかった可能性がある。過去の`import_runs`を遡って
影響範囲を確認するのが望ましい（未実施）。

## 暫定対応（実施済み）

cronの発火時刻を`0 0 * * *`（JST 09:00）へ復旧した（PR #39）。根本原因は未解消のため、
日次収集が引き続き不安定な可能性がある。

## 根本対応（実施済み）

調査の結果、根本原因は「7ジョブを1回の呼び出しに集約したこと」自体よりも、**Qiita/Zenn/arXivの
3インポーターが、fetchしたAPI候補を毎日無条件に全件AIレビュー・DB書き込みしていたこと**だと判明した
（arXivは既定`maxResults=50`で最大50件/日）。1件の新規/更新記事の処理には OpenAIレビュー1回＋
Supabase呼び出し6〜8回（既存チェック・upsert・タグ照合・item_tags同期）がかかるため、Qiitaの候補
20件だけでも120〜180 subrequestsに達し、本番で実際に上限超過が起きていた。

一方、Blog（Brave Search）・はてなブックマーク・RSSフィード追従の3インポーターは既に
「既に収集済みの記事は、AIレビュー・DB書き込み（および本文取得）を行わずスキップする」差分検知を
一部実装済みだった。この考え方を全6インポーター（Qiita/Zenn/arXiv/Blog/はてな/フィード）に統一し、
**記事内容の変更（本文更新）は追跡しない方針に振り切った**うえで、判定を「既存URLかどうか」だけの
シンプルなバッチクエリ（`findExistingExternalUrls`、`src/lib/importers/common.ts`）に一本化した。

- **Qiita/arXiv**: API一覧レスポンスの時点でURLが確定するため、`mapWithConcurrency`で回す前に
  既存URLをまとめて1回のクエリで判定し、既知の候補はAIレビュー・DB書き込みごとスキップする。
- **Zenn**: 一覧API（`GET /api/articles`）のレスポンスに記事パス（`path`）が含まれることが判明した
  ため、**詳細取得（`fetchZennArticleDetail`）を行う前に**既存URL判定ができるよう順序を入れ替えた。
  既に収集済みの記事は詳細取得自体（1候補1回のfetch）を丸ごと省略できる（ローカル検証では
  48件中44件で詳細取得なしにスキップ）。
- **Blog（Brave Search）・はてなブックマーク**: 発見（discovery）段階で候補URLをまとめて既存判定し、
  既知の候補は本文取得（HTML fetch）・本文ハッシュ計算・AIレビューを一切行わずスキップするよう
  変更した（RSSフィード追従の`feed.ts`が既に採用していた方式に統一）。
- 本文ハッシュによる差分検知（`findItemVersionByExternalUrl`）は全インポーターから削除した。
  既存記事の内容が更新されても再取り込みはされなくなる（意図した仕様）。

ローカルSupabaseに対する実行で、既存記事の大半が`reason: 'already collected'`として
AIレビュー・DB書き込み（Zennは詳細取得も）なしにスキップされることを確認済み
（Qiita 12件中11件、Zenn 48件中48件、arXiv 5件中5件、Blogは新規候補で正常動作を確認）。

cron構成（`wrangler.jsonc`の1回集約、`src/worker.ts`のジョブ順序・Discord通知）は変更していない。

Cloudflare Workers Paidプラン（$5/月、subrequest上限50→1000）へのアップグレードおよびOpenAIレビューの
複数記事バッチ化は、費用・実装リスクの観点からユーザー判断により見送った。

### 追加の最適化（実施済み）

上記の根本対応を踏まえ、さらに以下4点を実施した（cron trigger分割による日ごとのソース分散は、
効果検証のため別途実験予定として今回は見送り。実験結果は次節「候補5の要否判定」を参照）。

1. **リンク切れ検出（`link-check.ts`）のDB更新をバッチ化**: 最大`batchLimit`（既定100）件を
   1件ずつ`update`していたのを、probe結果をためて最後に1回の`upsert`にまとめた。更新分の
   subrequestを最大100→1に削減。
2. **`upsertItemByExternalUrl`の重複selectを省略（`assumeNew`オプション）**: Qiita/Zenn/arXivは
   呼び出し前に`findExistingExternalUrls`で対象が新規であることを保証済みのため、内部の既存行
   チェック（select）を省略できるようにした。新規記事1件につき1 subrequest削減。blog/hatena/feed
   は正規化後のURLが事前チェック時と異なりうるため対象外（既定のfalseのまま）。
3. **Qiita/arXivの既定候補件数を引き下げ**: `QIITA_PER_PAGE`を20→10、arXivの`DEFAULT_MAX_RESULTS`を
   50→20に変更。差分検知により通常時の負荷は新着記事数に比例するが、初回投入日・急増日の
   worst-caseの頭打ちとして安全マージンを増やした。
4. **タグ同期（`ensureTags`/`item_tags`）のジョブ単位バッチ化**: 全6インポーターで、新規記事の
   タグ同期をその場では行わず（`upsertItemByExternalUrl`に`syncTags: false`を渡す）、
   `{itemId, tags, tagLabels}`をジョブ内でためて、最後に`syncNewItemTagsBatch`（新設）で
   まとめて1回のタグ解決・`item_tags` insertを行うようにした。ジョブ内で新規記事がN件でも、
   タグ関連のSupabase呼び出しは記事数に比例せず固定回数（タグ解決1回＋`item_tags` insert1回）
   に近づく。新規挿入直後の記事は`item_tags`に既存行が無いことが前提のため、既存の`syncItemTags`
   （差分削除を含む汎用版、scripts/db/retag-existing-items.mjs等が引き続き使用）とは別関数として
   実装した。ローカルSupabaseで新規記事2件を同時処理し、タグが正しく紐付き、かつ既存タグの
   重複行が作られないことを直接確認した。

## 候補5（cronジョブ分割）の要否判定（実験結果）

候補1〜4実施後の実際のリクエスト量をローカル環境で実測した（詳細は
[docs/progress/2026-07-09.md](../progress/2026-07-09.md)）。要点:

- 差分検知は「既知記事1件あたりの追加コスト」をほぼ0まで下げることに成功した
  （Zennは詳細取得ごと省略、Qiita/arXivは即座にスキップ）。
- 一方、**新規/既存の判定に関わらず毎回固定で発生する2つの大きなコスト**が未対応で残る。
  - リンク切れ検出: 既定`LINK_CHECK_BATCH_LIMIT=100`により、対象URLへのprobe fetchが
    最大100件発生する（実測でも`fetched: 100`で上限に到達）。今回のバッチ化はDB更新側
    のみが対象で、probe fetch自体は削減できない。
  - ブログ（Brave Search）: `POKEMON_KEYWORDS`（6語）×既定`pages=5`で最大30ページ分の
    Brave Search API呼び出しが発見段階で発生し、差分検知の対象外（既存記事のスキップ判定
    より前に呼ばれるため）。
- この2つだけで概算130 subrequests前後になり、他5ジョブの固定コスト（各5〜15程度）を
  足すと、新規記事が全く無い日でも合計150〜170 subrequests程度に達する。新規記事の
  バックログが発生した日（実測でフィードの1購読から過去記事10件が一度に新規判定された
  例あり）は、1ジョブだけで上限を超えることもある。

**結論: 候補5（cronジョブの複数呼び出しへの分割）は依然として必要。**
`wrangler.jsonc`の`triggers.crons`は現在2件（週次レビュー・日次収集）のみでアカウント上限
5件のうち3件の空きがあるため、追加の仕組み無しに日次収集を2〜3個の独立したCron Trigger
エントリに分割するだけで対応できる見込み（例: リンク切れ検出を専用の発火時刻に分離、
収集6ジョブを2グループに分割）。

副次的に、`POST /api/import/blog`が`URI too long`エラーで失敗する既存バグを発見した
（本件とは無関係、未対応、別途調査が必要）。

### 実施: リンク切れ検出の専用cron分離・バッチサイズ自動算出

上記のうち、リンク切れ検出の分離を先行して実施した（詳細は
[docs/progress/2026-07-09.md](../progress/2026-07-09.md)）。

- リンク切れ検出のprobe fetchは新規/既存の判定に関わらず1件1fetchで、差分検知の対象外の
  ため、日次収集6ジョブ（`0 0 * * *`）とは別に専用のCron Trigger（`30 0 * * *`＝JST 09:30、
  `LINK_CHECK_CRON`）に分離した。
- 1回あたりのチェック件数（`LINK_CHECK_BATCH_LIMIT`）は、未指定時は対象総数から
  `ceil(対象件数 / recheckIntervalDays) + 余裕分`を自動算出し、`SAFE_MAX_BATCH_LIMIT=40`
  （probe fetch以外の固定コストを差し引いた、1回の呼び出し単体でsubrequest上限に収まる
  安全上限）で頭打ちにするよう変更した（`resolveAdaptiveBatchLimit`）。記事数が増えても
  手動調整不要で、上限到達後は「一巡にかかる日数が伸びる」形で緩やかに劣化するだけになる。
- ローカル環境（対象330件）で実測し、`fetched: 40`（`ceil(330/7)+5=53`が安全上限40で
  頭打ちになった値と一致）を確認した。

日次収集6ジョブ側の分割（例: 2グループ化）は未実施で、具体的な分割方針は別途合意のうえで
実装する。

### 実施: 日次収集バンドルの時間分割（PR #45）

上記の分割方針をユーザーと合意し、実装した。フィード/Qiita/Zenn/arXiv/はてなブックマークの
5ジョブを、単一の Cron Trigger 文字列 `"0,5,10,15,20 0 * * *"`（0:00〜0:20 UTCを5分刻みで
1日5回発火）にまとめ、`src/worker.ts` の `scheduled()` ハンドラが `controller.scheduledTime`
の分（UTC）からジョブを1つだけ選んで実行する（`DAILY_SLOT_JOBS`）ようにした。ジョブごとに
別々のWorker呼び出しになるため、1回あたりのsubrequestはそのジョブ単体分で済む。

スロットの順序（フィード→Qiita→Zenn→arXiv→はてな）は「記事の無駄な重複ができるだけ少なくなる」
ことを狙って決めた。Qiita/Zenn/arXivは固有ドメインのため重複がほぼ起きない。フィードは購読中の
個別ブログを直接ポーリングするため早い段階でURLを確定でき、はてなブックマークはWeb横断検索で
同一URLを再発見しやすいため最後に置くことで、既存URL判定（`findExistingExternalUrls`）による
スキップを最大化する。

ジョブが別々のWorker呼び出しに分かれた結果、以前のように1回の呼び出し内でメモリ上に全ジョブの
結果を集めて1通のDiscordまとめ通知を送る方式が使えなくなった。そこで全5スロット完了後の
`"40 0 * * *"`（0:40 UTC）に日次まとめ通知専用のCron Trigger（`DAILY_DIGEST_CRON`）を新設し、
当日 0:00 UTC 以降に作成された対象5ジョブのitemsを `items.collection_route` 列で絞り込んで
DBから直接集計する方式（`fetchDailyDigestItems`、`src/lib/importers/common.ts`）に変更した。

この時点で `wrangler.jsonc` の Cron Trigger 登録数はちょうどアカウント上限の5件
（週次レビュー・日次収集・リンク切れ検出・日次まとめ通知・ブログ）を使い切っていた。
全体像は [docs/scheduled-jobs.md](../scheduled-jobs.md) を参照。

### 実施: リンク切れ検出と日次まとめ通知の統合（1件の空き枠を確保）

上記でリンク切れ検出（`30 0 * * *`）・日次まとめ通知（`40 0 * * *`）を別々のCron Triggerに
分離した結果、アカウント上限5件を使い切っていた。両者のsubrequest消費を見積もると、
リンク切れ検出はprobe fetch最大`SAFE_MAX_BATCH_LIMIT`件＋DB呼び出し数件、日次まとめ通知は
DB集計1回＋Webhook送信1回で、合算しても概算45件前後にしかならずCloudflareの上限
（50/呼び出し）に収まる見込みが立った。そこで両者を `40 0 * * *` の1つのCron Trigger
（`LINK_CHECK_AND_DIGEST_CRON`、`src/worker.ts`）に統合し、Worker呼び出し内でリンク切れ検出→
まとめ通知の順にawaitするだけの実装にした（両者は互いの結果に依存せず、それぞれ内部で
try/catchと`sendOperationalAlert`を完結させているため、一方が失敗してももう一方の実行は
妨げない）。安全マージン確保のため、統合にあわせて`SAFE_MAX_BATCH_LIMIT`を40から35へ
引き下げた（`src/lib/importers/link-check.ts`）。

これによりアカウント全体のCron Trigger登録数上限（5件）に1件の空きができた
（週次レビュー・日次収集・リンク切れ検出＋日次まとめ通知・ブログの4件を使用）。
全体像は [docs/scheduled-jobs.md](../scheduled-jobs.md) を参照。

### 実施: ブログ（Brave Search）の専用cron分離・検索キーワードの巡回実行

ブログ収集の発見段階（Brave Search呼び出し）は、新規/既存の判定より前にかかる固定コストで
差分検知の対象外であり（`POKEMON_KEYWORDS`＝6語 × ページネーションで最大30件超）、
maxNewItemsPerRunによる新着件数の制限を組み合わせても、この固定コストだけで単独で
subrequest上限（50/呼び出し）に迫る・超えることが試算で判明した（1キーワードあたり
`pages`回のBrave呼び出し×6キーワード分が、他ジョブと合算される前の時点で既に大きい）。

また検索キーワードは記事の収集精度チューニングに応じて今後も増減する見込みであり、
「1日に何回・何キーワードずつ実行するか」をcron設定側にハードコードしたくないという要件が
あった。そこで以下の対応を実施した。

- 日次収集バンドル（`DAILY_CRON`）から分離し、専用のCron Trigger（`BLOG_CRON`＝
  `0 1,5,9,13,17,21 * * *`、4時間おきに1日6回発火）を新設した。アカウント全体のCron Trigger
  登録数上限（5件）に対し、これで4件使用（週次レビュー・日次収集・リンク切れ検出・ブログ）、
  1件の空きを残す。
- 発火のたびに`POKEMON_KEYWORDS`から1キーワードだけを選んで`syncBlogCollection`に
  `query`として渡す（`resolveBlogKeywordIndex`、`src/lib/importers/blog-rotation.ts`）。
  選び方は「発火時刻をBLOG_CRONの発火間隔（4時間）で割った通し番号を、その時点の
  キーワード数で割った余り」。キーワード配列の増減に対してコード変更・cron設定変更が
  一切不要で、キーワードが増えれば全キーワードを一巡するのに要する日数が伸びるだけ
  （緩やかな劣化）で自動的に追従する。
- これにより1回の呼び出しあたりのBrave呼び出し数は最大`pages`件（既定`pages=5`、`.env`の
  `BLOG_PAGES`で上書き可）まで下がり、6キーワード分の固定コストが1呼び出しに集中しなくなった。
- `resolveBlogKeywordIndex`はcloudflare:workers等の外部依存を持たない純粋関数として
  独立したファイル（`blog-rotation.ts`）に切り出し、ユニットテストを追加した
  （`tests/blog-keyword-rotation.test.ts`）。既存のprocess-import-item.ts・link-status.tsと
  同じ方針。
- ローカル環境で`POST /api/import/blog`に単一キーワードの`query`をJSONボディで渡して動作確認し
  （`{"query":"pokeapi","pages":1,"count":5}`）、`queries: ["pokeapi"]`・`requestsUsed: 1`と
  なることを確認した。この確認の過程で、`query`を渡さず全キーワード既定実行（`BLOG_PAGES=15`）を
  誤って呼び出した際に、既知の`URI too long`エラー（本件とは無関係、未対応の既存バグ）が
  再現することも改めて確認した。今回の変更は1回あたりの検索候補ボリュームを減らすため、この
  既存バグの再現頻度を下げる副次効果はあるが、根本修正はスコープ外のまま。

### 実施: 新着記事・論文の急増日対策（1回あたりの新規処理件数上限）

差分検知は「既知記事のスキップ」のみを行い、「1回の実行で新規として処理する件数」自体には
上限がなかった。試算の結果、arXiv（既定`maxResults=20`）は全件新規なら単独で約65
subrequests、Zenn（実測48件/回）は全件新規なら約190〜200 subrequestsとなり、他ジョブを
束ねなくても単独で上限を超えうることが判明した（詳細は
[docs/progress/2026-07-09.md](../progress/2026-07-09.md)）。また、一度どこかのジョブが
上限を超えると`sendOperationalAlert`自体も道連れで失敗し、記録も通知もされない
（当初の障害と同じ挙動）ことも確認した。

対応として、全6収集ジョブに「1回の実行でAIレビュー・DB書き込みを行う新規件数の上限
（`maxNewItemsPerRun`）」を追加した（既定値: Qiita/arXiv10、フィード6、Zenn/Blog/はてな6〜8、
`.env`の`*_MAX_NEW_PER_RUN`で上書き可能。フィードの既定値は後述の実測結果を受けて2026-07-09に
10から6へ引き下げた）。超過分は本文取得・詳細取得自体を省略してスキップし、
既存URL判定には残るため次回実行時に自然に再度候補となる（記事・論文が失われるわけではない）。
ローカル環境で`maxNewItemsPerRun`を意図的に1に絞って実行し、Qiita・Zennともに超過分が正しく
スキップされることを確認した。

## 2026-07-09: 実験によるsubrequest消費数の確定

各ジョブの`DEFAULT_MAX_NEW_ITEMS_PER_RUN`（`src/lib/importers/{qiita,zenn,arxiv,hatena,blog,feed}.ts`）の
根拠が「約N subrequests程度」という見積りに留まっていたため、実際にローカルでCloudflare Workers
のsubrequest数（Worker内から発行したfetch呼び出しの回数）を計測して確定させた。

### 計測の仕組み

`src/lib/subrequest-counter.ts`・`src/middleware.ts`・`scripts/eval/eval-subrequests.mjs`
（PR #55）で、`/api/import/*`のPOSTに対して`DEBUG_SUBREQUEST_COUNT=1`（`.dev.vars`に追記して
dev server再起動が必要）のときだけ実際のfetch呼び出し回数を数え、`X-Subrequest-Count`
レスポンスヘッダーに載せる仕組みを追加した。Supabaseクライアントは`@supabase/supabase-js`の
Vite依存事前バンドルの影響でグローバルなfetch差し替えだけでは計測できないため、
`createClient`の`global.fetch`オプションに計測用fetchを直接渡す方式にしている。

### 確定した値

各ルートについて「新規0件の定常状態（固定コスト）」と「対象を1件だけローカルDBから削除して
新規扱いにし、`maxNewItemsPerRun=1`で処理させたときの合計」を実測し、差分を新規1件あたりの
追加コストとした。

| ルート | 固定コスト（新規0件） | 新規1件あたり | 内訳 | 検証方法 |
|---|---|---|---|---|
| qiita | 11 | 2 | OpenAIレビュー1＋item upsert1（assumeNew） | 実測 |
| zenn | 5 | 3 | 詳細取得1＋OpenAIレビュー1＋item upsert1（assumeNew） | 実測（+5との差分はタグ同期バッチの初回コストで説明可） |
| arxiv | 5 | 2 | OpenAIレビュー1＋item upsert1（assumeNew） | コード読解（qiitaと同構造） |
| feed | 21 | 4 | fetch1＋既存チェック1＋OpenAIレビュー1＋item upsert1 | 実測 |
| hatena | **39（未解明）** | 4 | fetch1＋既存チェック1＋OpenAIレビュー1＋item upsert1 | 固定コストのみ実測、内訳はコード読解 |
| blog | 未再測定（既存見積り20〜23のまま） | 4 | fetch1＋既存チェック1＋OpenAIレビュー1＋item upsert1 | コード読解 |

いずれのルートも、新規記事が1件以上あるときだけ`syncNewItemTagsBatch`（既存タグのみなら
select 1回＋item_tags insert 1回の2件、新規タグ作成が絡むと最大5件程度）が一度だけ追加でかかる
（新規件数Nに比例せず、ジョブ内で1回だけ発生する点に注意）。

`DEFAULT_MAX_NEW_ITEMS_PER_RUN`件が全件新規だった場合のワーストケース（固定コスト＋N×新規1件
あたり＋タグ同期バッチ概算2）:

- qiita: 11+10×2+2 = **33**
- zenn: 5+8×3+2 = **31**
- arxiv: 5+10×2+2 = **27**
- feed: 旧既定値10では21+10×4+2 = 63となり上限50/呼び出しを超えることが判明したため、
  既定値を6へ引き下げた。**21+6×4+2 = 47**（上限50/呼び出し内に収まる）
- hatena: 39+6×4+2 = 65（固定コスト自体が未解明のため参考値）
- blog: 見積りベースで20〜23+6×4+2 ≒ 46〜49（既存見積りのまま、上限に近い）

### 未解明・持ち越しの課題

- **hatenaの固定コスト（実測39）が、コードから見積もる素朴な理論値（検索RSS取得6回＋既存URL
  一括チェック1回＋タグ上位取得1回≒9件程度）と大きく乖離している。** 内訳（原因）自体は
  未解明のまま。ただし本番`GET /api/import/runs`で実行履歴を確認したところ、直近のhatena
  実行（2026-07-09 08:20 UTC、`fetched:86, inserted:0, updated:0, skipped:86`＝全件が
  既存記事としてスキップされた新規0件のケース）は`status: succeeded`でエラーなく完了しており、
  上限超過や失敗は起きていない。実害（本番失敗）は確認されなかったため、内訳の深掘りは
  優先度を下げて持ち越す。
- **blogは`'pokeapi'`検索に未収集候補が多数残っており、「新規0件」の定常状態を作れず固定コストを
  再測定できなかった。** 既存見積り（20〜23）のまま。ただし2026-07-09にキーワードを1回の
  呼び出しにつき1語だけ処理するローテーション方式（`blog-rotation.ts`）へ変更済みのため、
  旧見積りより実コストはむしろ下がっている可能性が高く、優先度は低い。

## 副次的に判明したリスク（未対応）

`src/lib/openai.ts`のfetch呼び出しにタイムアウト・AbortControllerが設定されていない。
今回のsubrequest上限問題とは別軸で、OpenAI呼び出しが応答しないケースがあれば
そのジョブ（および同一Worker呼び出し内の後続ジョブ）が無期限にハングしうる。
