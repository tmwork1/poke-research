// Qiita 収集ジョブを API 経由で起動するエンドポイント。
// デフォルトの検索条件は環境変数から読み、POST では上書きを受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
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

	const result = await syncQiitaCollection(resolveQiitaSyncOptions(env, requestData));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
