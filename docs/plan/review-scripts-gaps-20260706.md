# レビュー・クリーンアップ系スクリプトの不足点（2026-07-06 棚卸し）

`npm run eval:all`（[2026-07-06 進捗](../progress/2026-07-06.md)で追加）でM5の4観点（収集クエリ/検索/フィルタ/タグ）は1コマンドでまとめて回せるようになったが、その過程で items/sources/tags を事後レビュー・追加削除する既存の仕組み（`scripts/db/*`、`scripts/eval/*`）に穴があることが分かった。着手時は本ドキュメントのチェックボックスを更新する。

## 1. sources専用の重複検出スクリプトが無い（優先度: 中 / 工数: 中）

items には `scripts/db/detect-duplicate-items.mjs`（URL正規化+タイトル類似度）、tags には `scripts/eval/eval-tags.mjs`＋`scripts/db/merge-tag.mjs` があるが、**sources の重複・表記ゆれを検出する手段が無い**。同じブログ・著者が Brave 収集経由で微妙に違う `name`/`origin_url` の別 source 行になるケースが実際に起きている（2026-07-05〜06 の Brave収集品質対策で本番 sources 6件を手作業削除）。

- `scripts/db/detect-duplicate-sources.mjs` を新設し、`origin_url` の正規化一致・`name` の類似度で候補を出す（`detect-duplicate-items.mjs` の正規化ロジックを流用可能）。
- 統合は `merge-tag.mjs` と同様のパターン（items の `source_id` を付け替えてから重複 source を削除）で `scripts/db/merge-source.mjs` を用意する。

## 2. `eval-tags.mjs` が使用0件のタグを検出しない（優先度: 中 / 工数: 小）

現行クエリは `tags` と `item_tags` の INNER JOIN のため、**使用件数0件のタグ（`merge-tag.mjs` 統合後の残骸や、作成されたが一度も付与されなかったタグ）が一覧に出てこない**。ノイズタグの後始末がここで漏れる。

- `eval-tags.mjs` に LEFT JOIN + `usage_count = 0` の別セクションを追加し、削除候補として一覧表示する（削除自体は既存の手動SQL運用のままでよい）。

## 3. 重複items検出が「検出止まり」で運用ループに乗っていない（優先度: 中 / 工数: 小〜中）

`detect-duplicate-items.mjs` は候補を一覧表示するだけで、実際にどちらを残す/削除するかの判断とAPI経由の削除は完全に手動。加えてこのスクリプトは `README.md` のM5節（4観点のループ）に載っておらず、`eval:all` にも含まれていないため存在を忘れやすい。

- README M5節に一言追記し、`npm run eval:all` の実行後に定期的に流す運用ステップとして明示する（Brave同様に quota 制約は無いため既定実行に含めてよい）。

（2026-07-06 追記: 検出結果の保存先だった `item_relations` テーブルは未運用のまま使われず、実データ（重複検出7件）以外に活用先がなかったため `migrations/017` で削除した。あわせて `detect-duplicate-items.mjs` もDB書き込み（`--apply`）を廃止し、都度再計算して表示するだけのツールにした。「一覧から選んで削除する対話的ヘルパー」を作る場合は、保存済みペアを前提にせず、実行のたびに検出したペアに対して直接動く形で設計し直す必要がある。）

（2026-07-06 追記: `eval-all.mjs` への組み込みと scripts.md/README への運用明文化を実施済み。`detect-duplicate-items.mjs` を `eval:all` の既定ステップ（既存4本の後、最後）に追加し、docs/reference/scripts.md 第4章に「実行のきっかけ」として収集後／プロンプト変更後のレビュー運用を明記した。）

## 4. AIフィルタの偽陰性（誤って棄却された記事）が構造的にレビュー不能（優先度: 低〜中 / 工数: 中〜大）

`eval-filter.mjs` はDBに入った記事（＝AIに採用された記事）しか見られないため、**誤って棄却された良記事（偽陰性）を原理的に検出できない**。現状は `eval:collection` の生タイトル一覧とDB内タイトルを手動で突き合わせるしかない。

- 案A: 棄却された記事も `metadata.ai.accepted=false` 付きで一旦 `items` に保存し、一覧・検索からは除外する（`link_status` の除外と同じ仕組みを流用）。ストレージは増えるが偽陰性レビューが可能になる。
- 案B: 収集ジョブの棄却ログだけを別テーブル（例: `rejected_candidates`）に軽量記録し、`eval-filter.mjs` 同様に「現行プロンプト基準で読み直す」対象に含める。
- どちらもスキーマ変更を伴うため、着手前にユーザー判断が必要。

## 5. annotationsのレビュー手段が無い（優先度: 低 / 工数: 小）

items/sources/tags と異なり、annotations（`GET/POST /api/annotations`）には内容を一覧して精査するスクリプトが無い。件数が増えてきたら `scripts/eval/eval-annotations.mjs`（記事タイトルと紐付けて一覧出力するだけの読み取り専用スクリプト）を追加する。

## 6. リンク切れ確定後の目視レビュー導線が無い（優先度: 低 / 工数: 小）

`link-check.ts` は2回連続到達不能で `link_status='broken'` を確定させ誤検知を抑制しているが、**確定後に「本当に切れているか」を人が見返す定期導線が無い**。一時的なサイト側障害やUser-Agentブロックを恒久的なリンク切れと誤認したままになる可能性がある。

- `scripts/eval/eval-broken-links.mjs`（`link_status='broken'` のitemを `link_broken_since` の古い順に一覧出力するだけ）を追加し、`eval:all` とは別に月次程度で目視確認する運用にする。
