# 定期ジョブ（Cron）一覧

Cloudflare Workers の Cron Trigger はアカウント全体で登録数が5件までという上限があるため（現行プラン）、`wrangler.jsonc` の `triggers.crons` には5つのエントリしか置けない。個々のジョブはこの5エントリの中に収まるよう、複数ジョブを1つのエントリに時間分割で束ねたり、1つのジョブが発火のたびに処理対象の一部だけを選んで実行したりしている。振り分けロジックは `src/worker.ts` の `scheduled()` ハンドラに集約されている。

## 登録済み Cron Trigger（4件、上限5件のうち1件は空き）

| # | cron式 | 発火時刻（UTC） | 発火時刻（JST） | 内容 |
|---|---|---|---|---|
| 1 | `30 20 * * 1` | 毎週月曜 20:30 | 毎週火曜 05:30 | 週次DBレビュー |
| 2 | `0,5,10,15,20 0 * * *` | 毎日 0:00, 0:05, 0:10, 0:15, 0:20 | 毎日 09:00, 09:05, 09:10, 09:15, 09:20 | 日次収集（フィード/Qiita/Zenn/arXiv/はてなブックマーク、時間分割） |
| 3 | `40 0 * * *` | 毎日 0:40 | 毎日 09:40 | リンク切れ検出＋日次まとめ通知（1つのCron Triggerに統合） |
| 4 | `0 1,5,9,13,17,21 * * *` | 4時間おき（1,5,9,13,17,21時） | 4時間おき（10,14,18,22,2,6時） | ブログ（Brave Search）、キーワード巡回 |

note（非公式API、403 Access denied のため自動実行対象外）と単発バックフィル系は cron 化していない。手動起動用の `POST /api/import/*` は各インポーターに残っている。

## 日次収集（#2）: なぜ時間分割か、順序の根拠

以前は日次収集5ジョブ（フィード/Qiita/Zenn/arXiv/はてな）を1つの Cron Trigger（`0 0 * * *`）に集約し、1回のWorker呼び出し内で順にawaitして実行していた。この設計は Cloudflare の「1回のWorker呼び出しあたりのsubrequest数上限」（無料/標準プランで50/呼び出し）と衝突し、新着記事の急増日などに実際に上限超過が発生した（詳細: [docs/issue/cron-subrequest-limit.md](issue/cron-subrequest-limit.md)）。

差分検知（既存URL判定によるスキップ）・新着処理件数上限（`maxNewItemsPerRun`）等の対策を行った上で、根本対応として、1つの Cron Trigger 文字列 `"0,5,10,15,20 0 * * *"` の中でジョブごとに発火時刻（分）を分け、各スロットを別々のWorker呼び出しにした。`controller.cron` はどのスロットでも同一文字列になるため、`src/worker.ts` は `controller.scheduledTime` の分（UTC）から実行するジョブを1つだけ選ぶ（`DAILY_SLOT_JOBS`）。

スロットの順序（フィード→Qiita→Zenn→arXiv→はてな）は「記事の無駄な重複ができるだけ少なくなる」ことを狙って決めている。

- Qiita/Zenn/arXivは固有ドメイン（qiita.com/zenn.dev/arxiv.org）のため、他ジョブとの重複はほぼ起きない。
- フィードは購読中の個別ブログを直接ポーリングするため、そのブログの記事URLを早い段階で確定できる。
- はてなブックマークはWeb横断のブックマーク検索のため、フィードなどが既に収集済みの同一URLを再発見しやすい。既存URL判定（`findExistingExternalUrls`、`src/lib/importers/common.ts`）は既に収集済みのURLを早期スキップするため、はてなを最後に置くことで、その時点までに他ジョブが収集済みのURLがはてなの判定でも無駄なくスキップされる。

## リンク切れ検出＋日次まとめ通知（#3）: 1つのCron Triggerへ統合

以前はリンク切れ検出（`30 0 * * *`）と日次まとめ通知（`40 0 * * *`）を別々のCron Triggerに分離していたが、両者を合算してもsubrequest数が概算45件前後でCloudflareの上限（50/呼び出し）に収まる見込みが立ったため、`40 0 * * *` の1つのCron Trigger（`LINK_CHECK_AND_DIGEST_CRON`、`src/worker.ts`）に統合した。Worker呼び出し内でリンク切れ検出→まとめ通知の順にawaitするだけで、日次収集ジョブ群のような時間分割スロット判定は不要（両者は互いの結果に依存せず、それぞれ内部でtry/catchと`sendOperationalAlert`を完結させているため、一方が失敗してももう一方の実行は妨げない）。統合によりアカウント全体のCron Trigger登録数上限（5件）に1件の空きができた。

リンク切れ検出は「新着」の概念がなく、対象URLへのprobe fetch自体が1件1fetchで差分検知による削減ができない。1回あたりのチェック件数は対象総数から自動算出し（`resolveAdaptiveBatchLimit`、`src/lib/importers/link-check.ts`）、安全上限 `SAFE_MAX_BATCH_LIMIT` で頭打ちにすることで、この呼び出し単体でsubrequest上限を超えないようにしている。統合にあわせてこの安全上限を40から35へ引き下げ、日次まとめ通知分（DB集計1回＋Webhook送信1回）の余裕を確保した。

日次まとめ通知は、日次収集ジョブが別々のWorker呼び出しに分かれたため、以前のように1回の呼び出し内でメモリ上に全ジョブの結果を集めて1通のDiscordダイジェストを送る方式が使えない。そこで全5スロット（`0:00`〜`0:20 UTC`）完了後に発火する本Cron Triggerから、当日 `0:00 UTC` 以降に作成された対象5ジョブの items を `items.collection_route` 列で絞り込んでDBから直接集計し（`fetchDailyDigestItems`、`src/lib/importers/common.ts`）、1通のDigestとしてDiscordへ送る（`sendDailyDigest`、`src/lib/notify.ts`）。合計0件でも必ず送信するため、まとめ通知そのものが「cronが正常に実行された」ことの確認シグナルとして機能する。

## ブログ／Brave Search（#4）

発見段階のキーワード検索が新規/既存の判定より前にかかる固定コストで、差分検知でも削減できない。また検索キーワード（`POKEMON_KEYWORDS`）は今後も増減しうるため、「1日に何回・何キーワードずつ実行するか」をcron側にハードコードしたくない。そこで1日6回（4時間おき）発火させ、発火のたびに `resolveBlogKeywordIndex`（`src/lib/importers/blog-rotation.ts`）が発火時刻からキーワードを1つだけ選んで実行する。キーワード数が変わっても、一巡に要する日数が伸び縮みするだけでコード変更は不要。

## 週次DBレビュー（#1）

items/sources の重複候補を検出するだけの読み取り専用ジョブ（DBは書き換えない）。統合が必要な候補は `scripts/db/merge-item.mjs` / `merge-source.mjs` を人手で確認して実行する。

## 関連ドキュメント

- [docs/issue/cron-subrequest-limit.md](issue/cron-subrequest-limit.md) — subrequest上限問題の発覚経緯と対策の全体像
- [docs/reference/operations.md](reference/operations.md) — デプロイ手順・監視・障害対応
- `src/worker.ts` — cronの振り分けロジック本体
- `wrangler.jsonc` — 登録cronの定義とコメントによる設計意図の記録
