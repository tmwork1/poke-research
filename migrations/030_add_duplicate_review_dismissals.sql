-- migrations/030_add_duplicate_review_dismissals.sql
-- 週次DBレビュー（src/lib/maintenance-review.ts、毎週月曜にDiscordへ重複候補を通知）は、
-- 統合されない限り同じ組を毎週再掲する。実際には統合しない（別記事・別ソースだと判断した）
-- 組も混ざるため、そのままでは「毎週同じ内容が届き、毎週同じ判断をやり直す」ことになる。
-- 人手で「これは重複ではない」と判断した組をここに記録し、以後のレビュー対象から除外する。
--
-- 記録は scripts/db/dismiss-duplicate.mjs で行う。from_id < to_id に正規化して保存する
-- （同じ組が向き違いで二重登録されるのを主キーで防ぐため）。
-- items/sources への外部キーは張らない（target_kind によって参照先テーブルが変わるため）。
-- 対象行が削除されても除外レコードが残るだけで実害はなく、id（serial）は再利用されないため
-- 別の行が誤って除外されることもない。

CREATE TABLE IF NOT EXISTS duplicate_review_dismissals (
  target_kind text NOT NULL CHECK (target_kind IN ('item', 'source')),
  from_id bigint NOT NULL,
  to_id bigint NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_kind, from_id, to_id),
  CONSTRAINT duplicate_review_dismissals_id_order CHECK (from_id < to_id)
);

-- audit_logs / import_runs（migrations/027）と同じ内部運用専用テーブル。ポリシーを追加せず、
-- 匿名/authenticated からは到達不可・service_role のみが読み書きできる状態にする。
ALTER TABLE duplicate_review_dismissals ENABLE ROW LEVEL SECURITY;

-- migrations/029 と同様、本番DB上で権限が欠落しないよう明示的に付与する。
-- UPDATE は主キー3列＋noteのみの表で、判断の訂正は削除→再登録で足りるため付与しない。
GRANT SELECT, INSERT, DELETE ON public.duplicate_review_dismissals TO service_role;
