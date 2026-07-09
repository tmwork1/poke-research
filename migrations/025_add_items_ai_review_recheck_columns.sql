-- migrations/025_add_items_ai_review_recheck_columns.sql
-- AIレビューの判定条件・結果をSQLで直接比較できるよう、2組のフラット列を追加する。
--
-- ai_review_*（model/prompt_hash/reason/confidence/reviewed_at）: 「今公開されている内容
-- （ai_accepted・summary・tags）を生んだ判定」。ai_accepted/summary/tags と同時にのみ更新される
-- （shouldPreserveAcceptedItem で書き込みがスキップされた場合は更新しない）。
-- ai_accepted列（migrations/018）が accepted だけを items.metadata->'ai'.accepted から
-- 昇格させているのと同じ発想を、model/prompt_hash/reason/confidence にも広げたもの。
-- prompt_hash は system prompt 本文（buildSystemPrompt の出力）のSHA-256ハッシュで、
-- バージョン番号のような人為的な連番ではなく実体そのものを指すため「hash」と呼ぶ
-- （src/lib/importers/ai-review-prompt.mjs の computePromptHash）。
--
-- ai_recheck_*（accepted/model/prompt_hash/reason/confidence/rechecked_at）: 「直近の
-- 再チェック」。ai_accepted とは別に、shouldPreserveAcceptedItem で ai_accepted 自体の更新が
-- 握りつぶされた場合でも常に上書きする。
--
-- この2組を分けたのは、ai_review_* が無いと「公開中の判定 vs 直近の再チェック」の比較で片方が
-- items.metadata->'ai'->>'prompt_hash' のjsonb抽出になり、構造が非対称でSQLで素直に比較
-- できない問題があったため（docs/issue/items-schema-scalability.md 参照。背景: docs/progress/2026-07-10.md）。
-- 2組が揃うことで、例えば次のクエリで「公開中だが直近の再チェックが現行プロンプトと食い違って
-- いる記事」を直接抽出できる:
--   SELECT * FROM items WHERE ai_accepted AND ai_review_prompt_hash IS DISTINCT FROM ai_recheck_prompt_hash;

ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_review_model text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_review_prompt_hash text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_review_reason text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_review_confidence real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_reviewed_at timestamptz;

ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_accepted boolean;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_model text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_prompt_hash text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_reason text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_recheck_confidence real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_rechecked_at timestamptz;

-- 既存データの無料バックフィル: prompt_hash/reviewed_at・rechecked_at はバージョン管理の
-- 概念自体が過去に無かったため再現不可能（NULLのまま = 「まだ一度も追跡下でチェックされて
-- いない」の正しいシグナルとして扱う）。model/reason/confidence は既存の metadata.ai.* に
-- そのまま残っているため、追加のOpenAI呼び出し無しでSQLだけで埋める（既存行はすべて
-- ai_review_* = ai_recheck_* の状態からスタートする、という初期状態として自然）。
UPDATE items
SET
	ai_review_model = metadata->'ai'->>'model',
	ai_review_reason = metadata->'ai'->>'reason',
	ai_review_confidence = (metadata->'ai'->>'confidence')::real,
	ai_recheck_accepted = (metadata->'ai'->>'accepted')::boolean,
	ai_recheck_model = metadata->'ai'->>'model',
	ai_recheck_reason = metadata->'ai'->>'reason',
	ai_recheck_confidence = (metadata->'ai'->>'confidence')::real
WHERE ai_review_model IS NULL AND metadata->'ai'->>'model' IS NOT NULL;

-- 「ai_accepted=true だが直近prompt_hashが現行と異なる」の抽出を速くする。
CREATE INDEX IF NOT EXISTS idx_items_ai_accepted_recheck_prompt_hash
	ON items (ai_accepted, ai_recheck_prompt_hash);
