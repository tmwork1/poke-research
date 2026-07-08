// arXiv 論文収集ジョブを API 経由で起動するエンドポイント。
// 既定の検索条件はコード（src/lib/importers/arxiv.ts の DEFAULT_QUERY）で管理し、
// POST では明示的な上書きのみ受け付ける（他インポーターと同じ方針）。
// 今回のスコープでは wrangler.jsonc の cron には組み込まず、手動起動のみとする
// （docs/plan/paper.md、Cloudflareアカウントのcron trigger数上限のため）。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { runAndRecord } from '../../../lib/import-runs';
import { resolveArxivSyncOptions, syncArxivCollection } from '../../../lib/importers/arxiv';

export const prerender = false;

interface ArxivImportRequest {
	query?: string;
	maxResults?: number;
	start?: number;
}

export async function GET() {
	const defaults = resolveArxivSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'arxiv',
			query: defaults.query,
			maxResults: defaults.maxResults,
			start: defaults.start,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<ArxivImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.query !== undefined && typeof requestData.query !== 'string') {
		return badRequest('query must be a string');
	}

	const result = await runAndRecord('arxiv', 'api', () => syncArxivCollection(resolveArxivSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
