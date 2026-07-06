// はてなブックマーク収集ジョブ（検索RSS）を API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/keywords.ts）で管理し、POST では明示的な上書きのみ受け付ける。
import { env } from 'cloudflare:workers';

import { runAndRecord } from '../../../lib/import-runs';
import { resolveHatenaSyncOptions, syncHatenaCollection } from '../../../lib/importers/hatena';
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';

export const prerender = false;

interface HatenaImportRequest {
	keyword?: string;
	maxCandidatesPerKeyword?: number;
}

export async function GET() {
	const defaults = resolveHatenaSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'hatena',
			keyword: defaults.keyword,
			maxCandidatesPerKeyword: defaults.maxCandidatesPerKeyword,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<HatenaImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.keyword !== undefined && typeof requestData.keyword !== 'string') {
		return badRequest('keyword must be a string');
	}

	const result = await runAndRecord('hatena', 'api', () => syncHatenaCollection(resolveHatenaSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
