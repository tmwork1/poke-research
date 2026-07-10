// OpenAlexの未収録候補を、AIレビュー・DB書き込み無しで取得するだけのエンドポイント。
// 2026-07-10、OpenAlex過去分の手動バックフィル用（一度きり）。Claude Codeセッション内の
// Haikuサブエージェントがこの候補を読み、自身の判定結果を POST /api/import/openalex/apply-reviews
// へ渡す2段階構成にすることで、DB書き込み・タグ同期ロジック（common.ts）は既存の
// 本番実装をそのまま再利用する（../../../../lib/importers/openalex.ts 参照）。
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../../_shared';
import { fetchOpenAlexCandidates } from '../../../../lib/importers/openalex';

export const prerender = false;

interface OpenAlexCandidatesRequest {
	filter?: string;
	maxResults?: number;
	page?: number;
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<OpenAlexCandidatesRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.filter !== undefined && typeof requestData.filter !== 'string') {
		return badRequest('filter must be a string');
	}

	const result = await fetchOpenAlexCandidates({
		filter: requestData.filter,
		maxResults: requestData.maxResults,
		page: requestData.page,
	});

	return jsonResponse({ data: result });
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = () => methodNotAllowed(['POST']);
export const PATCH = PUT;
export const DELETE = PUT;
