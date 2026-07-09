# 定期ジョブ（Cron）一覧

Cloudflare Workers の Cron Trigger はアカウント全体で登録数が5件までという上限があるため（現行プラン）、`wrangler.jsonc` の `triggers.crons` には5つのエントリしか置けない。個々のジョブはこの5エントリの中に収まるよう、複数ジョブを1つのエントリに時間分割で束ねたり、1つのジョブが発火のたびに処理対象の一部だけを選んで実行したりしている。振り分けロジックは `src/worker.ts` の `scheduled()` ハンドラに集約されている。

## 登録済み Cron Trigger（3件、上限5件のうち2件は空き）

| # | cron式 | 発火時刻（UTC） | 発火時刻（JST） | 内容 |
|---|---|---|---|---|
| 1 | `30 11 * * 1` | 毎週月曜 11:30 | 毎週月曜 20:30 | 週次DBレビュー |
| 2 | `0,5,10,15,20,25,59 15 * * *` | 毎日 15:00, 15:05, 15:10, 15:15, 15:20, 15:25, 15:59 | 毎日 00:00, 00:05, 00:10, 00:15, 00:20, 00:25, 00:59 | 日次収集（フィード/Qiita/Zenn/arXiv/はてなブックマーク）＋リンク切れ検出＋日次まとめ通知（時間分割） |
| 3 | `0 1,5,9,13,17,21 * * *` | 4時間おき（1,5,9,13,17,21時） | 4時間おき（10,14,18,22,2,6時） | ブログ（Brave Search）、キーワード巡回 |

note（非公式API、403 Access denied のため自動実行対象外）と単発バックフィル系は cron 化していない。手動起動用の `POST /api/import/*` は各インポーターに残っている。

## 日次収集＋リンク切れ検出＋日次まとめ通知（#2）: なぜ時間分割か、順序の根拠

以前は日次収集5ジョブ（フィード/Qiita/Zenn/arXiv/はてな）を1つの Cron Trigger（`0 0 * * *`）に集約し、1回のWorker呼び出し内で順にawaitして実行していた。この設計は Cloudflare の「1回のWorker呼び出しあたりのsubrequest数上限」（無料/標準プランで50/呼び出し）と衝突し、新着記事の急増日などに実際に上限超過が発生した（詳細: [docs/issue/cron-subrequest-limit.md](issue/cron-subrequest-limit.md)）。

差分検知（既存URL判定によるスキップ）・新着処理件数上限（`maxNewItemsPerRun`）等の対策を行った上で、根本対応として、1つの Cron Trigger 文字列 `"0,5,10,15,20,25,59 15 * * *"` の中でジョブごとに発火時刻（分）を分け、各スロットを別々のWorker呼び出しにした。`controller.cron` はどのスロットでも同一文字列になるため、`src/worker.ts` は `controller.scheduledTime` の分（UTC）から実行するジョブを1つだけ選ぶ（`DAILY_SLOT_JOBS`）。

スロットの順序（フィード→Qiita→Zenn→arXiv→はてな→リンク切れ検出→日次まとめ通知）は「記事の無駄な重複ができるだけ少なくなる」ことと「後段ジョブが前段の収集結果に依存する」ことを狙って決めている。

- Qiita/Zenn/arXivは固有ドメイン（qiita.com/zenn.dev/arxiv.org）のため、他ジョブとの重複はほぼ起きない。
- フィードは購読中の個別ブログを直接ポーリングするため、そのブログの記事URLを早い段階で確定できる。
- はてなブックマークはWeb横断のブックマーク検索のため、フィードなどが既に収集済みの同一URLを再発見しやすい。既存URL判定（`findExistingExternalUrls`、`src/lib/importers/common.ts`）は既に収集済みのURLを早期スキップするため、収集5ジョブの最後にはてなを置くことで、その時点までに他ジョブが収集済みのURLがはてなの判定でも無駄なくスキップされる。
- リンク切れ検出・日次まとめ通知は収集5ジョブの結果に依存する（まとめ通知は当日分の収集結果をDBから集計する）ため、収集5ジョブより後段のスロットに置く。

### リンク切れ検出・日次まとめ通知を時間分割へ統合（旧: 1つのCron Triggerへの統合）

以前はリンク切れ検出と日次まとめ通知を、日次収集ジョブ群とは別の専用Cron Trigger（`40 15 * * *`、`LINK_CHECK_AND_DIGEST_CRON`）1つに統合し、Worker呼び出し内で順にawaitするだけの実装にしていた（アカウント全体のCron Trigger登録数上限（5件）を1件節約する目的）。だが両者が同一Worker呼び出しのsubrequest予算（50/呼び出し）を分け合う必要があり、その分だけリンク切れ検出の1回あたりチェック件数（`SAFE_MAX_BATCH_LIMIT`）を40から35に頭打ちにせざるを得なかった。

リンク切れ確認が扱えるリクエスト数を最大化するため、`LINK_CHECK_AND_DIGEST_CRON`を廃止し、日次収集ジョブ群と同じ時間分割の`DAILY_CRON`にスロット（分25＝リンク切れ検出、分59＝日次まとめ通知）として組み込んだ。それぞれ独立したWorker呼び出しになったことで、リンク切れ検出は単体でsubrequest上限50を使い切れるようになり、安全上限`SAFE_MAX_BATCH_LIMIT`を40へ戻した（`src/lib/importers/link-check.ts`）。副次効果として、旧`LINK_CHECK_AND_DIGEST_CRON`分のCron Trigger登録が不要になり、アカウント全体の登録数上限（5件）の空きが1件から2件に増えた。

リンク切れ検出は「新着」の概念がなく、対象URLへのprobe fetch自体が1件1fetchで差分検知による削減ができない。1回あたりのチェック件数は対象総数から自動算出し（`resolveAdaptiveBatchLimit`、`src/lib/importers/link-check.ts`）、安全上限`SAFE_MAX_BATCH_LIMIT`で頭打ちにすることで、この呼び出し単体でsubrequest上限を超えないようにしている。

日次まとめ通知は、日次収集ジョブが別々のWorker呼び出しに分かれたため、以前のように1回の呼び出し内でメモリ上に全ジョブの結果を集めて1通のDiscordダイジェストを送る方式が使えない。そこで全収集5スロット・リンク切れ検出（`15:00`〜`15:25 UTC`）完了後、前段ジョブの遅延・タイムアウトに対する余裕を限界まで確保するため、同じ時（15時）内で分の値として指定できる最大値である`15:59 UTC`のスロットで発火させ、当日 `0:00 UTC` 以降に作成された対象5ジョブの items を `items.collection_route` 列で絞り込んでDBから直接集計し（`fetchDailyDigestItems`、`src/lib/importers/common.ts`）、1通のDigestとしてDiscordへ送る（`sendDailyDigest`、`src/lib/notify.ts`）。合計0件でも必ず送信するため、まとめ通知そのものが「cronが正常に実行された」ことの確認シグナルとして機能する。

## ブログ／Brave Search（#3）

発見段階のキーワード検索が新規/既存の判定より前にかかる固定コストで、差分検知でも削減できない。また検索キーワード（`BLOG_KEYWORDS`、Qiita/note等が使う`POKEMON_KEYWORDS`とは独立管理）は今後も増減しうるため、「1日に何回・何キーワードずつ実行するか」をcron側にハードコードしたくない。そこで1日6回（4時間おき）発火させ、発火のたびに `resolveBlogKeywordIndex`（`src/lib/importers/blog-rotation.ts`）が発火時刻からキーワードを1つだけ選んで実行する。キーワード数が変わっても、一巡に要する日数が伸び縮みするだけでコード変更は不要。

## 週次DBレビュー（#1）

items/sources の重複候補を検出するだけの読み取り専用ジョブ（DBは書き換えない）。統合が必要な候補は `scripts/db/merge-item.mjs` / `merge-source.mjs` を人手で確認して実行する。毎週月曜 11:30 UTC は、同じ月曜 15:00 UTC に始まる日次収集（#2）の直前（3.5時間前）になるよう配置している。

## 発火時刻（#1〜#2）の相互関係

週次DBレビュー（#1）→ 日次収集＋リンク切れ検出＋日次まとめ通知（#2）の順序と間隔（週次DBレビューは日次収集の3.5時間前）を保っている。ブログ（#3）は日次収集（#2）の結果に依存しないため変更していない。

## 関連ドキュメント

- [docs/issue/cron-subrequest-limit.md](issue/cron-subrequest-limit.md) — subrequest上限問題の発覚経緯と対策の全体像
- [docs/reference/operations.md](reference/operations.md) — デプロイ手順・監視・障害対応
- `src/worker.ts` — cronの振り分けロジック本体
- `wrangler.jsonc` — 登録cronの定義とコメントによる設計意図の記録
