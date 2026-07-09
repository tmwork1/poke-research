-- migrations/025_add_items_ai_last_review_columns.sql
-- 直近の再レビュー時点の条件（モデル名・プロンプトversion）と結果（採否・理由・確信度・日時）を
-- 常に上書き記録する列を追加する。ai_accepted（公開可否、一度採用された記事は自動格下げしない
-- 既存方針、migrations/018）とは役割が異なり、shouldPreserveAcceptedItem
-- （src/lib/importers/process-import-item.ts）によって既存行への書き込みがスキップされた場合でも
-- こちらは常に更新することで、「ai_accepted=true のまま古いプロンプト基準の判定が凍結されている
-- 記事」をSQLで直接抽出できるようにする（背景: docs/progress/2026-07-10.md）。
-- 値は items.metadata->'ai' と重複するが、jsonbは人間が読む詳細ログ、こちらはSQLで問い合わせる
-- ための構造化データという役割分担にする（ai_accepted列とmetadata.ai.acceptedの重複と同じ考え方）。

ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_review_accepted boolean;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_review_model text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_review_prompt_version text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_review_reason text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_review_confidence real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_last_reviewed_at timestamptz;

-- 既存データの無料バックフィル: prompt_version/reviewed_at はバージョン管理の概念自体が
-- 過去に無かったため再現不可能（NULLのまま = 「まだ一度も追跡下で再レビューされていない」の
-- 正しいシグナルとして扱う）。accepted/model/reason/confidence は既存の metadata.ai.* に
-- そのまま残っているため、追加のOpenAI呼び出し無しでSQLだけで埋める。
UPDATE items
SET
	ai_last_review_accepted = (metadata->'ai'->>'accepted')::boolean,
	ai_last_review_model = metadata->'ai'->>'model',
	ai_last_review_reason = metadata->'ai'->>'reason',
	ai_last_review_confidence = (metadata->'ai'->>'confidence')::real
WHERE ai_last_review_model IS NULL AND metadata->'ai'->>'model' IS NOT NULL;

-- 「ai_accepted=true だが直近prompt_versionが現行と異なる」の抽出を速くする。
CREATE INDEX IF NOT EXISTS idx_items_ai_accepted_review_prompt_version
	ON items (ai_accepted, ai_last_review_prompt_version);
