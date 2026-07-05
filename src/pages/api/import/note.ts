// note 収集ジョブを API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/keywords.ts）で管理し、POST では明示的な上書きのみ受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { resolveNoteSyncOptions, syncNoteCollection } from '../../../lib/importers/note';

export const prerender = false;

interface NoteImportRequest {
	query?: string;
	pages?: number;
	perPage?: number;
}

export async function GET() {
	const defaults = resolveNoteSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'note',
			query: defaults.query,
			pages: defaults.pages,
			perPage: defaults.perPage,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<NoteImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await syncNoteCollection(resolveNoteSyncOptions(env, requestData));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
