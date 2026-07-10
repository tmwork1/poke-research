// GET /api/import/openalex/candidates で取得した候補に対する判定結果（accepted/summary/tags/
// reason/confidence/language）を受け取り、既存の本番DB書き込みパス（applyOpenAlexReviews、
// upsertItemByExternalUrl・syncNewItemTagsBatch）でそのまま保存するエンドポイント。
// 2026-07-10、OpenAlex過去分の手動バックフィル用（一度きり）。Claude Codeセッション内の
// Haikuサブエージェントが判定したものだけを受け付ける想定で、OpenAI（reviewImportArticle）は
// 呼ばない。判定はこの呼び出し元（サブエージェント）の責任で行う——このエンドポイント自身は
// 妥当性の粗いチェック（必須フィールドの型）のみ行う。
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../../_shared';
import { applyOpenAlexReviews, type OpenAlexManualReview } from '../../../../lib/importers/openalex';

export const prerender = false;

interface ApplyReviewsRequest {
	filter?: string;
	reviews?: unknown;
}

function isValidReview(value: unknown): value is OpenAlexManualReview {
	if (!value || typeof value !== 'object') return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.externalUrl === 'string' &&
		r.externalUrl.length > 0 &&
		typeof r.title === 'string' &&
		Array.isArray(r.authors) &&
		typeof r.abstract === 'string' &&
		typeof r.openalexId === 'string' &&
		typeof r.version === 'string' &&
		typeof r.accepted === 'boolean' &&
		typeof r.summary === 'string' &&
		Array.isArray(r.tags) &&
		typeof r.reason === 'string' &&
		typeof r.language === 'string'
	);
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<ApplyReviewsRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (typeof requestData.filter !== 'string' || !requestData.filter.trim()) {
		return badRequest('filter must be a non-empty string');
	}
	if (!Array.isArray(requestData.reviews) || requestData.reviews.length === 0) {
		return badRequest('reviews must be a non-empty array');
	}
	const invalidIndex = requestData.reviews.findIndex((review) => !isValidReview(review));
	if (invalidIndex !== -1) {
		return badRequest(`reviews[${invalidIndex}] is missing required fields`);
	}

	const result = await applyOpenAlexReviews(requestData.filter, requestData.reviews as OpenAlexManualReview[]);

	return jsonResponse({ data: result }, 201);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = () => methodNotAllowed(['POST']);
export const PATCH = PUT;
export const DELETE = PUT;
