// リンク切れ検出ジョブを API 経由で起動するエンドポイント（migrations/016）。
// 他の収集ジョブと異なり新規アイテムは作らないが、cron / 手動実行 / import_runs への記録という
// 枠組みを揃えるため /api/import 配下に置く。バッチ件数等はコードの既定値を使い、POST では
// 明示的な上書き（動作確認・緊急再実行時など）のみ受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { runAndRecord } from '../../../lib/import-runs';
import { checkLinks, resolveLinkCheckOptions } from '../../../lib/importers/link-check';

export const prerender = false;

interface CheckLinksRequest {
	batchLimit?: number;
	concurrency?: number;
	recheckIntervalDays?: number;
	timeoutMs?: number;
}

export async function GET() {
	const defaults = resolveLinkCheckOptions(env);
	return jsonResponse({
		data: {
			provider: 'link-check',
			batchLimit: defaults.batchLimit,
			concurrency: defaults.concurrency,
			recheckIntervalDays: defaults.recheckIntervalDays,
			timeoutMs: defaults.timeoutMs,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<CheckLinksRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	for (const key of ['batchLimit', 'concurrency', 'recheckIntervalDays', 'timeoutMs'] as const) {
		if (requestData[key] !== undefined && typeof requestData[key] !== 'number') {
			return badRequest(`${key} must be a number`);
		}
	}

	const result = await runAndRecord('link-check', 'api', () => checkLinks(resolveLinkCheckOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
