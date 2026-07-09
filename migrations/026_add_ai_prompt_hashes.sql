-- migrations/026_add_ai_prompt_hashes.sql
-- items.ai_review_prompt_hash / ai_recheck_prompt_hash（migrations/025）は「同じか違うか」の
-- 比較にしか使えず、あるハッシュ値が実際にどのプロンプト文面だったかを引く手段が無かった。
-- 過去のハッシュの中身を知るには、src/lib/importers/ai-review-prompt.mjs の該当コミットを
-- git log で探し、そのコミット時点のコードで computePromptHash() を再計算して照合するしかない。
--
-- プロンプト全文を保存すると、既に全文・全履歴をgitが持っている内容を複製するだけになるため、
-- 最小限として「このハッシュを最初に見た日時」だけを記録する参照テーブルを追加する。
-- first_seen_at と git log の日時を突き合わせれば、どのコミットのプロンプトかを絞り込める
-- （プロンプト自体は ai-review-prompt.mjs の履歴を直接見るのが正）。
CREATE TABLE IF NOT EXISTS ai_prompt_hashes (
	prompt_hash text PRIMARY KEY,
	kind text NOT NULL,
	first_seen_at timestamptz NOT NULL DEFAULT now()
);
