import { env } from 'cloudflare:workers';

import { jsonResponse, methodNotAllowed } from '../_shared';
import { hasRecentImportRun } from '../../../lib/import-runs';
import { formatWeeklyReviewMessage, runWeeklyReview } from '../../../lib/maintenance-review';
import { sendMaintenanceReport } from '../../../lib/notify';

export const prerender = false;

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST() {
	const result = await runWeeklyReview();
	let message = formatWeeklyReviewMessage(result);

	const sinceIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
	const hasRecent = await hasRecentImportRun(sinceIso);
	if (!hasRecent) {
		message += '\n\n⚠️ 直近7日間、収集ジョブの実行記録がありません。GitHub Actions の定期実行が止まっていないか確認してください。';
	}

	await sendMaintenanceReport(env, '週次DBレビュー', message);

	return jsonResponse(
		{
			data: {
				itemCandidates: result.itemCandidates.length,
				sourceCandidates: result.sourceCandidates.length,
				hasRecentImportRun: hasRecent,
			},
		},
		201,
	);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
