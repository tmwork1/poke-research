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

export async function processImportItem<TReview extends ImportReviewOutcome>(
	externalUrl: string,
	title: string,
	review: () => Promise<TReview>,
	upsert: (review: TReview) => Promise<{ id: number; action: 'inserted' | 'updated' }>,
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
