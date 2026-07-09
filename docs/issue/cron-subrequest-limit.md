# 日次cronがCloudflare Workersのsubrequest数上限と衝突する問題

- **発覚日**: 2026-07-09
- **状態**: 恒久対応実施済み（Qiita/Zenn/arXivへの差分検知移植。ブランチ`fix/cron-subrequest-diff-detection`）
- **関連PR**: #36（日次通知の集約）、#37（動作確認用の一時cron変更）、#39（09:00へ復旧）

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
「前回収集時と内容（本文ハッシュ or 更新日時）が同じなら、AIレビュー・DB書き込みを行わずスキップする」
差分検知を実装済みだった（`findItemVersionByExternalUrl`、`src/lib/importers/common.ts`）。この
差分検知をQiita/Zenn/arXivにも移植し（バッチ版の`findExistingItemVersions`を新設し、候補記事URLを
まとめて1回のクエリで問い合わせる）、変更のない記事の無駄な再レビューをなくすことで、cron呼び出し
あたりのsubrequest数とOpenAI課金の両方を削減した。ローカルSupabaseに対する実行で、既存記事の
大半が`reason: 'unchanged since last collection'`としてAIレビュー・DB書き込みなしにスキップされる
ことを確認済み（Qiita 3件中2件、Zenn 48件中44件、arXiv 5件中5件）。

cron構成（`wrangler.jsonc`の1回集約、`src/worker.ts`のジョブ順序・Discord通知）は変更していない。

Cloudflare Workers Paidプラン（$5/月、subrequest上限50→1000）へのアップグレードは、ユーザーが
Cloudflareダッシュボードで別途判断・実施する事項として今回のスコープ外とした。

## 副次的に判明したリスク（未対応）

`src/lib/openai.ts`のfetch呼び出しにタイムアウト・AbortControllerが設定されていない。
今回のsubrequest上限問題とは別軸で、OpenAI呼び出しが応答しないケースがあれば
そのジョブ（および同一Worker呼び出し内の後続ジョブ）が無期限にハングしうる。
