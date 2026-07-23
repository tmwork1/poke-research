// GitHubの未収録候補を、AIレビュー・DB書き込み無しで取得するだけのエンドポイント。
// 2026-07-23、GitHubリポジトリ初期投入の手動バックフィル用（一度きり）。Claude Codeセッション内の
// サブエージェントがこの候補（README付き）を読み、自身の判定結果を
// POST /api/import/github/apply-reviews へ渡す2段階構成にすることで、DB書き込み・タグ同期ロジック
// （common.ts）は既存の本番実装をそのまま再利用する（../../../../lib/importers/github.ts 参照）。
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../../_shared';
import { fetchGithubCandidates } from '../../../../lib/importers/github';

export const prerender = false;

interface GithubCandidatesRequest {
	query?: string;
	maxResults?: number;
	page?: number;
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<GithubCandidatesRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await fetchGithubCandidates({
		query: requestData.query,
		maxResults: requestData.maxResults,
		page: requestData.page,
	});

	return jsonResponse({ data: result });
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = () => methodNotAllowed(['POST']);
export const PATCH = PUT;
export const DELETE = PUT;
