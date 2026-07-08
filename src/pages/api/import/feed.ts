// 登録済みRSS/Atomフィード（feed_subscriptions）を直接ポーリングする収集ジョブを
// API 経由で起動するエンドポイント。既定の上限件数はコード（feed.ts）で管理し、
// POST では明示的な上書きのみ受け付ける。
import { env } from 'cloudflare:workers';

import { runAndRecord } from '../../../lib/import-runs';
import { resolveFeedSyncOptions, syncFeedCollection } from '../../../lib/importers/feed';
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';

export const prerender = false;

interface FeedImportRequest {
	maxEntriesPerFeed?: number;
}

export async function GET() {
	const defaults = resolveFeedSyncOptions(env);
	return jsonResponse({
		data: {
			provider: 'feed',
			maxEntriesPerFeed: defaults.maxEntriesPerFeed,
		},
	});
}

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<FeedImportRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	if (requestData.maxEntriesPerFeed !== undefined && typeof requestData.maxEntriesPerFeed !== 'number') {
		return badRequest('maxEntriesPerFeed must be a number');
	}

	const result = await runAndRecord('feed', 'api', () => syncFeedCollection(resolveFeedSyncOptions(env, requestData)));

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
