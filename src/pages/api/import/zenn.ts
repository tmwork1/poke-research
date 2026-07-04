// Zenn 収集ジョブを API 経由で起動するエンドポイント。
// デフォルトの収集条件は環境変数から読み、POST では上書きを受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { resolveZennSyncOptions, syncZennCollection } from '../../../lib/importers/zenn';

export const prerender = false;

interface ZennImportRequest {
	topic?: string;
	pages?: number;
}

export async function GET() {
	const defaults = resolveZennSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'zenn',
			topic: defaults.topic,
			pages: defaults.pages,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<ZennImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.topic !== undefined && typeof requestData.topic !== 'string') {
		return badRequest('topic must be a string');
	}

	const result = await syncZennCollection(resolveZennSyncOptions(env, requestData));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
