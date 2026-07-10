// OpenAlex 論文収集ジョブを API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/openalex.ts の DEFAULT_FILTER）で管理し、
// POST では明示的な上書きのみ受け付ける（arxiv.ts の API ルートと同じ方針）。
// cron（src/worker.ts の DAILY_SLOT_JOBS）からも定期実行されるが、このAPIは手動起動・
// 動作確認用として引き続き利用できる。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { runAndRecord } from '../../../lib/import-runs';
import { resolveOpenAlexSyncOptions, syncOpenAlexCollection } from '../../../lib/importers/openalex';

export const prerender = false;

interface OpenAlexImportRequest {
	filter?: string;
	maxResults?: number;
	page?: number;
}

export async function GET() {
	const defaults = resolveOpenAlexSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'openalex',
			filter: defaults.filter,
			maxResults: defaults.maxResults,
			page: defaults.page,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<OpenAlexImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.filter !== undefined && typeof requestData.filter !== 'string') {
		return badRequest('filter must be a string');
	}

	const result = await runAndRecord('openalex', 'api', () => syncOpenAlexCollection(resolveOpenAlexSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
