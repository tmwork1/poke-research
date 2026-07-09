-- migrations/025_add_items_ai_recheck_columns.sql
-- 直近の再チェック時点の条件（モデル名・プロンプトversion）と結果（採否・理由・確信度・日時）を
-- 常に上書き記録する列を追加する。ai_accepted（公開可否、一度採用された記事は自動格下げしない
-- 既存方針、migrations/018）とは役割が異なり、shouldPreserveAcceptedItem
-- （src/lib/importers/process-import-item.ts）によって既存行への書き込みがスキップされた場合でも
-- こちらは常に更新することで、「ai_accepted=true のまま古いプロンプト基準の判定が凍結されている
-- 記事」をSQLで直接抽出できるようにする（背景: docs/progress/2026-07-10.md）。
-- 列名を ai_recheck_* とし、ai_accepted や items.metadata->'ai'（公開中の内容と対になり凍結される
-- 詳細ログ）とは異なる「常に最新化される再チェック結果」であることを明示する
-- （docs/issue/items-schema-scalability.md: metadata.ai と競合しうる情報のため、link_status系の
-- ような単純な「最新値のみ保持する列」と違い、区別を示す修飾語を残す判断をした）。

ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_accepted boolean;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_model text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_prompt_version text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_reason text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_confidence real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_rechecked_at timestamptz;

-- 既存データの無料バックフィル: prompt_version/rechecked_at はバージョン管理の概念自体が
-- 過去に無かったため再現不可能（NULLのまま = 「まだ一度も追跡下で再チェックされていない」の
-- 正しいシグナルとして扱う）。accepted/model/reason/confidence は既存の metadata.ai.* に
-- そのまま残っているため、追加のOpenAI呼び出し無しでSQLだけで埋める。
UPDATE items
SET
	ai_recheck_accepted = (metadata->'ai'->>'accepted')::boolean,
	ai_recheck_model = metadata->'ai'->>'model',
	ai_recheck_reason = metadata->'ai'->>'reason',
	ai_recheck_confidence = (metadata->'ai'->>'confidence')::real
WHERE ai_recheck_model IS NULL AND metadata->'ai'->>'model' IS NOT NULL;

-- 「ai_accepted=true だが直近prompt_versionが現行と異なる」の抽出を速くする。
CREATE INDEX IF NOT EXISTS idx_items_ai_accepted_recheck_prompt_version
	ON items (ai_accepted, ai_recheck_prompt_version);
