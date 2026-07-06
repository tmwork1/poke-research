# 開発ロードマップ — 情報ハブ（Information Hub）構想に基づく版

## 目的
このプロジェクトは、ポケモンプログラミングに関する技術情報を収集・整理・検索する情報ハブを目指す。

## 要件サマリ
- コンテンツ中心: `sources` / `items` を中心に、注釈を付与する。
- メタデータ重視: 出典、収集日時、バージョン、ライセンスを扱う。
- 検索性: メタデータ検索、全文検索、タグ、フィルタで探せること。
- 再現性と履歴: 更新履歴と provenance を残す。
- 共有とアクセス制御: 公開／非公開、ユーザー／チーム単位の管理を見据える。

## コア概念
- Source: データの出典。
- Item: Source から取り込んだ個別レコード。
- Annotation: Item に付与されるタグやコメント、評価。
- Provenance: 収集時の情報。

## データモデルの方針
- `items` は汎用テーブルとして扱う。
- 種別の差分は `kind` と `metadata` で表現する。
- AI 要約や分類結果は `annotations` に寄せる。

## マイルストーン
### M1: 基盤整備
- [x] スキーマを確定し、`sources` / `items` / `annotations` を中心に初期マイグレーションを整える。
- [x] API の入出力形式を揃え、CRUD の最低限の振る舞いを通す。
- [x] ローカル開発用の接続確認、マイグレーション適用、CRUD スモークテストまでを通しで確認する。

### M2: 検索と画面の初期実装
- [x] 一覧画面の絞り込み、全文検索、タグ検索、トップ／一覧／詳細／検索結果の主要導線を実装する。
- [x] API に検索パラメータを渡し、検索結果と詳細表示をつなげる。
- [x] M3 として API 取り込みと provenance 付与に進む。

### M3: 収集・取り込みの自動化
- [x] Qiita を最初の収集対象として、外部 API からの取り込み経路を実装する。
- [x] 収集ジョブを定期実行できる形にし、失敗時の再実行手順も用意する。
- [x] provenance を保存し、どのソースからいつ取り込まれたか追跡できるようにする。
- [x] Qiita で確立した取り込み経路をもとに、Zenn / note（対応可能な範囲）へ収集対象を拡張する。
  - [x] Zenn（非公式 API。`topicname` によるトピック検索、`/api/articles/{slug}` で本文・タグを取得）
  - [x] note（非公式 API。`/api/v3/searches` によるキーワード検索、`/api/v3/notes/{key}` で本文・タグを取得。有料/メンバーシップ限定記事は `can_read` で除外）
  - GitHub（リポジトリ）は対象外とする。閲覧者にとって記事よりリポジトリは読むハードルが高く、この情報ハブの想定読者に合わないため。
  - [x] 個人ブログは特定ブログの購読ではなく、Brave Search API（公式・ドキュメント化された検索API）でのキーワード検索により発見する方針とし、実装した（`src/lib/brave.ts`、`src/lib/importers/blog.ts`）。除外ドメインは `src/lib/importers/keywords.ts` の `EXCLUDED_BLOG_DOMAINS`（Qiita/Zenn/note/GitHub/YouTube/X に加え、検索結果を占有しがちな企業攻略サイト yakkun.com/gamewith.jp/appmedia.jp/game8.jp/altema.jp/gamerch.com。検索クエリの `-site:` と結果フィルタの両方で除く）と `FILTERED_BLOG_DOMAINS`（はてなブックマーク・Pinterest・SourceForge・アプリストア等のアグリゲータ。クエリ文字数を抑えるため結果フィルタのみで除く）に分けて管理する。任意サイトの本文抽出は Cloudflare の `HTMLRewriter` で行い（`article`→`main`→`body` の順にフォールバック）、`items.version` に本文ハッシュを保存して差分が無ければ AI レビューを省略する。詳細仕様は [docs/spec/brave-search-blog-import.md](spec/brave-search-blog-import.md) を参照。本番調査でツール提供ページ（ダメージ計算ツール等）や攻略サイトが多数取り込まれた問題への対応は [2026-07-06](progress/2026-07-06.md) を参照。
  - YouTube は対象外とする。YouTube Data API v3 で検索自体は可能だが、記事本文に相当するテキスト（字幕・文字起こし）を任意の動画から確実に取得する手段が無く、概要欄だけでは AI レビューの精度が確保できないため。
  - Brave Search API での自動発見を補う形で、UI から記事単体の URL を投稿できる手動登録機能も将来検討する（ブログのトップページ単位ではなく、記事そのものの URL に限定する。ブログ単位だと更新の有無を追う仕組み＝RSS 自動検出などが別途必要になり、対象ブログによっては検知できないため）。実装はリリース後のアップデートで対応し、M3 の完了条件には含めない。

### M4: 運用機能の追加
- [x] 公開／非公開や権限の境界を整理し、アクセス制御を導入する。単一管理者 + 公開読み取りの構成とし、`.env` の `ADMIN_USERNAME`/`ADMIN_PASSWORD` による Basic 認証を `src/middleware.ts` で実装。`/api/audit` は常時、それ以外の `/api/**` は書き込み系メソッドのみ保護する。
- [x] 編集履歴と監査ログを追加し、変更の追跡性を高める。`audit_logs` テーブル（`migrations/003_add_audit_log.sql`）と `src/lib/audit.ts` を追加し、items/sources/annotations の insert/update/delete を `GET /api/audit` から参照できるようにした。
- [x] 必要なデータを CSV などで出力できるようにする。`GET /api/export/items.csv` を追加し、`/api/items` と同じ q/kind/tag/sourceId フィルタで絞り込んだ items を CSV（UTF-8 BOM 付き）で出力できるようにした。

### M5: 検索最適化とUI詳細設計
- [x] 実データを使って検索条件（絞り込み、全文検索、タグ、フィルタの組み合わせ）を検証し、精度と使い勝手を最適化する。全文検索が日本語で機能していなかった問題（`search_vector` → `pg_trgm`）、タグの大文字小文字重複、AIレビューの採用基準の甘さ、Qiita収集クエリが本文全文一致でノイズを大量に拾っていた問題の4点を修正した。詳細は [2026-07-05](progress/2026-07-05.md) を参照。
- [x] 一覧・検索結果画面のUIを詳細設計し、情報設計とレイアウトを磨き込む（アイテム詳細画面は情報量が薄いため廃止し、カードから元記事へ直接遷移する構成に統一した）。アクセントカラーをQiitaの緑と被らない色味に調整し、検索ページ上部に英語表記（eyebrow）を追加、ヘッダー右上のナビをTopのホームアイコン1つに簡略化した。
- [x] 検索とUIの両面で、一覧・トップ・詳細画面の情報設計を反復的に磨き込んだ（冗長な見出し・装飾・重複情報の削除、日付表示を元記事の公開日基準に変更など）。詳細は [2026-07-05](progress/2026-07-05.md) を参照。追加のUI改善アイデアは [docs/plan/ui_improve_plan_20260705.md](plan/ui_improve_plan_20260705.md) に整理し、必要になった時点で着手する。

### M6: リリース準備と安定化
- [x] CI/CD でマイグレーションと基本検証を自動化する。GitHub Actions（`.github/workflows/ci.yml`）で `npm run build` と、使い捨て Postgres コンテナへの `migrations/*.sql` 適用検証を `master` への push / pull request で自動実行する。Cloudflare Workers を GitHub の `master` ブランチと連携し、コードのビルド・デプロイは push で自動化した。本番 Supabase へのマイグレーション適用（`npm run release`）は自動デプロイの対象外のため手動のまま維持する（`docs/reference/operations.md` 参照）。
- [x] バックアップと復旧の運用手順を確立する。自前のバックアップ処理は実装せず、Supabase 標準のバックアップ機能に依拠する方針とし、復旧手順を `docs/reference/operations.md` に文書化した。
- [x] README、運用メモ、開発手順を整備して、引き継ぎしやすい状態にする。デプロイ手順・バックアップ／復旧手順・障害対応の初動を `docs/reference/operations.md` として新設し、README に CI の説明と `docs/reference/operations.md` への導線を追加した。

### M7: Googleログインとマイページ
- [x] Supabase Auth 経由の Google ログインを実装した（コードは完了、`npm run build`・`astro dev`（本番Supabase接続）で疎通確認済み）。本番でのGoogleプロバイダ有効化（Supabaseダッシュボード＋Google Cloud Console、ユーザー操作）待ちのため、実際のログイン成功は未確認。
- [x] ログイン後にアクセスできる `/mypage` を追加し、お気に入り（ブックマーク）機能を実装した（`migrations/007_add_bookmarks.sql`、`/api/bookmarks*`、`ItemCard`のトグルボタン）。本番マイグレーション適用待ち。
- [x] 管理者Basic認証とは別レーンの認可として実装し（`src/middleware.ts`）、items/sources/annotationsの編集権限は変更していない。
- [x] ローカル開発は `import.meta.env.DEV` 時のみダミーセッションユーザーでGoogle認証をバイパスし、本番のみ実際のGoogleログインを要求する構成にした（ビルド後の`dist`からダミー分岐が除去されることを確認済み）。
- [x] 本番環境でのGoogle Cloud Console／Supabaseダッシュボード設定（OAuthクライアント、リダイレクトURI、Google プロバイダ有効化）、`npm run release`による本番マイグレーション（006/007）適用、ブラウザでの実ログイン〜`/mypage`表示〜お気に入り追加/削除のエンドツーエンド確認まで完了した。
- 詳細仕様は [docs/spec/mypage-auth.md](spec/mypage-auth.md) を参照。実装内容・検証状況は [2026-07-05](progress/2026-07-05.md) を参照。

### 横断的に継続すること
- [ ] スキーマ変更時は、API と画面の整合性も同時に確認する。
- [ ] 収集データは provenance とライセンス条件を必ず確認する。
- [ ] 各マイルストーンごとに `docs/progress/YYYY-MM-DD.md` を更新し、完了条件を明確にする。

## 運用方針
- タスク管理: `manage_todo_list` を使う。
- 進捗記録: `docs/progress/YYYY-MM-DD.md` に残す。
- ガバナンス: 外部データの利用条件を守り、個人情報や機密情報は取り込まない。

