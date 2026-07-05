// ブログ収集ジョブ（Brave Search API）を API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/keywords.ts）で管理し、POST では明示的な上書きのみ受け付ける。
import { env } from 'cloudflare:workers';

import { getBraveConfig } from '../../../lib/brave';
import { resolveBlogSyncOptions, syncBlogCollection } from '../../../lib/importers/blog';
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';

export const prerender = false;

interface BlogImportRequest {
	query?: string;
	count?: number;
	offset?: number;
	pages?: number;
}

export async function GET() {
	const defaults = resolveBlogSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'blog',
			query: defaults.query,
			count: defaults.count,
			offset: defaults.offset,
			pages: defaults.pages,
			hasToken: Boolean(getBraveConfig().apiKey),
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<BlogImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await syncBlogCollection(resolveBlogSyncOptions(env, requestData));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
