// GitHubリポジトリ収集ジョブをAPI経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/github.ts のDEFAULT_QUERY）で管理し、
// POSTでは明示的な上書きのみ受け付ける（他インポーターと同じ方針）。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { runAndRecord } from '../../../lib/import-runs';
import { resolveGithubSyncOptions, syncGithubCollection } from '../../../lib/importers/github';

export const prerender = false;

interface GithubImportRequest {
	query?: string;
	maxResults?: number;
}

export async function GET() {
	const defaults = resolveGithubSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'github',
			query: defaults.query,
			maxResults: defaults.maxResults,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<GithubImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await runAndRecord('github', 'api', () => syncGithubCollection(resolveGithubSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
