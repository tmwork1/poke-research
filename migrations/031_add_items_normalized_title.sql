-- migrations/031_add_items_normalized_title.sql
-- OpenAlex（src/lib/importers/openalex.ts）は、同じ成果物を別のWork objectとして複数保持する
-- ことがある。特にZenodoは1レコードにつき concept DOI と version DOI（多くは連番）が発行され、
-- OpenAlex側でも別Workとして返ってくるため、external_url の UNIQUE 制約（migrations/002）では
-- 重複を防げず、同一タイトルの論文が毎週2行ずつ増えていた（2026-09-19時点で週次DBレビューの
-- 重複候補36組のうち大半がこのパターン）。OSFのpreprintとOpenAlex ID行の組み合わせも同様。
--
-- 収集時に「同じタイトルの論文が既にあるか」を1クエリで判定できるよう、記号・空白を除去して
-- 小文字化した正規化タイトルを生成列として持つ。JS側の正規化（src/lib/importers/title-dedup.ts の
-- normalizeTitleForDedup）と同じ結果になるよう、英数字（Unicode）以外をすべて除去する。
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS normalized_title text
  GENERATED ALWAYS AS (lower(regexp_replace(coalesce(title, ''), '[^[:alnum:]]+', '', 'g'))) STORED;

CREATE INDEX IF NOT EXISTS idx_items_normalized_title ON items(normalized_title);
