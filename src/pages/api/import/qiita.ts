// Qiita 収集ジョブを API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/keywords.ts）で管理し、POST では明示的な上書きのみ受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { runAndRecord } from '../../../lib/import-runs';
import { resolveQiitaSyncOptions, syncQiitaCollection } from '../../../lib/importers/qiita';

export const prerender = false;

interface QiitaImportRequest {
	query?: string;
	pages?: number;
	perPage?: number;
	token?: string;
}

export async function GET() {
	const defaults = resolveQiitaSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'qiita',
			query: defaults.query,
			pages: defaults.pages,
			perPage: defaults.perPage,
			hasToken: Boolean(defaults.token),
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<QiitaImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await runAndRecord('qiita', 'api', () => syncQiitaCollection(resolveQiitaSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
