// 記事単位のAIレビュー結果を受けて DB 書き込み（upsert）を呼び出す共通ロジック。
// getSupabaseClient（cloudflare:workers 依存）や OpenAI 呼び出し（article-ai.ts 経由で
// 同じく cloudflare:workers 依存）を実装から切り離し、コールバック注入型の純粋な関数として
// node --test から直接テストできるようにする（catalog-normalize.ts と同じ切り出し方針）。
// review/upsert の実処理（reviewImportArticle・upsertItemByExternalUrl）は common.ts 側に残す。

export interface ImportReviewOutcome {
	accepted: boolean;
	reason: string;
}

export interface ImportItemOutcome {
	id: number | null;
	action: 'inserted' | 'updated' | 'skipped';
	externalUrl: string;
	title: string;
	reason?: string;
}

/**
 * 一度採用され公開中の記事（既存行 ai_accepted=true）を、収集ジョブの再レビューが棄却に
 * 反転しても ai_accepted=false へ格下げすべきでないか判定する（true なら書き込みを行わない）。
 * Qiita/Zenn/note は毎回の収集で既存記事も再レビューするため、境界記事では判定が揺れうる。
 * ここで格下げを許すと公開記事が収集のたびに一覧から見えたり消えたりするので、
 * retag-existing-items.mjs の「不採用判定になった場合は自動削除せず警告のみ」方針と揃えて
 * 保存自体をスキップする（metadata.ai.accepted=false だけ書くと eval-filter の
 * 採用分/偽陰性セクションの判定と ai_accepted 列が食い違うため、部分的な書き込みも不可）。
 * existingAiAccepted が undefined の場合は DEFAULT true（migrations/018）として扱い格下げしない。
 */
export function shouldPreserveAcceptedItem(existingAiAccepted: boolean | undefined, incomingAiAccepted: boolean): boolean {
	if (incomingAiAccepted) return false;
	return existingAiAccepted !== false;
}

/**
 * items.ai_last_review_* 列（migrations/025）の値。ai_accepted とは別に、直近の再レビューが
 * 何を条件に何と判定したかを常に上書き記録する（shouldPreserveAcceptedItem で ai_accepted の
 * 更新が握りつぶされた場合でも、こちらは常に更新する。common.ts の upsertItemByExternalUrl 参照）。
 */
export interface AiReviewColumns {
	ai_last_review_accepted: boolean;
	ai_last_review_model: string;
	ai_last_review_prompt_version: string;
	ai_last_review_reason: string;
	ai_last_review_confidence: number | null;
	ai_last_reviewed_at: string;
}

export function buildAiReviewColumns(
	review: { accepted: boolean; model: string; promptVersion: string; reason: string; confidence: number | null },
	reviewedAtIso: string,
): AiReviewColumns {
	return {
		ai_last_review_accepted: review.accepted,
		ai_last_review_model: review.model,
		ai_last_review_prompt_version: review.promptVersion,
		ai_last_review_reason: review.reason,
		ai_last_review_confidence: review.confidence,
		ai_last_reviewed_at: reviewedAtIso,
	};
}

export async function processImportItem<TReview extends ImportReviewOutcome>(
	externalUrl: string,
	title: string,
	review: () => Promise<TReview>,
	upsert: (review: TReview) => Promise<{ id: number; action: 'inserted' | 'updated' | 'skipped' }>,
): Promise<ImportItemOutcome> {
	// 1件の失敗がバッチ全体を止めないよう、記事単位で例外を吸収して skipped として積む。
	// review() が例外を投げた場合（AI呼び出し失敗など）は結果が無く保存しようがないため、
	// 従来どおり保存せず skipped のままにする。
	try {
		const result = await review();
		// AIに棄却された記事も items には保存する（案A、migrations/018）。ただし action は
		// 従来どおり 'skipped' のままにして、消費側（collectスクリプトの出力・/api/import/*の
		// レスポンス・import_runsのサマリー集計）の後方互換を保つ。upsert 側で
		// ai_accepted=false とタグ同期スキップを担う（各インポーターの upsert 実装を参照）。
		// なお、一度採用され公開中の既存記事への棄却レビューは upsert 側
		// （shouldPreserveAcceptedItem）が書き込み自体をスキップして action='skipped' を返すが、
		// ここでの outcome は棄却時どのみち 'skipped' + reason なので区別せずそのまま扱える。
		const upserted = await upsert(result);
		if (!result.accepted) {
			return { id: upserted.id, action: 'skipped', externalUrl, title, reason: result.reason };
		}

		return { id: upserted.id, action: upserted.action, externalUrl, title };
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl,
			title,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}
