// GET /api/import/github/candidates で取得した候補に対する判定結果（accepted/summary/tags/
// reason/confidence/language）を受け取り、既存の本番DB書き込みパス（applyGithubReviews、
// upsertItemByExternalUrl・syncNewItemTagsBatch）でそのまま保存するエンドポイント。
// 2026-07-23、GitHubリポジトリ初期投入の手動バックフィル用（一度きり）。Claude Codeセッション内の
// サブエージェントが判定したものだけを受け付ける想定で、OpenAI（reviewImportArticle）は
// 呼ばない。判定はこの呼び出し元（サブエージェント）の責任で行う——このエンドポイント自身は
// 妥当性の粗いチェック（必須フィールドの型）のみ行う。
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../../_shared';
import { applyGithubReviews, type GithubManualReview } from '../../../../lib/importers/github';

export const prerender = false;

interface ApplyReviewsRequest {
	query?: string;
	reviews?: unknown;
}

function isValidReview(value: unknown): value is GithubManualReview {
	if (!value || typeof value !== 'object') return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.externalUrl === 'string' &&
		r.externalUrl.length > 0 &&
		typeof r.title === 'string' &&
		Array.isArray(r.authors) &&
		typeof r.readmeExcerpt === 'string' &&
		typeof r.repoId === 'number' &&
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
	if (typeof requestData.query !== 'string' || !requestData.query.trim()) {
		return badRequest('query must be a non-empty string');
	}
	if (!Array.isArray(requestData.reviews) || requestData.reviews.length === 0) {
		return badRequest('reviews must be a non-empty array');
	}
	const invalidIndex = requestData.reviews.findIndex((review) => !isValidReview(review));
	if (invalidIndex !== -1) {
		return badRequest(`reviews[${invalidIndex}] is missing required fields`);
	}

	const result = await applyGithubReviews(requestData.query, requestData.reviews as GithubManualReview[]);

	return jsonResponse({ data: result }, 201);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = () => methodNotAllowed(['POST']);
export const PATCH = PUT;
export const DELETE = PUT;
