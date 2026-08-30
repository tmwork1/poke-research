import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { DAILY_COLLECTION_ROUTES, fetchDailyDigestItems } from '../../../lib/importers/common';
import { sendDailyDigest } from '../../../lib/notify';
import { topic } from '../../../config/topic.config.mjs';

export const prerender = false;

interface DailyDigestRequest {
	since?: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST({ request }: { request: Request }) {
	const body = await readJsonBody<Partial<DailyDigestRequest>>(request);
	if (body.response) return body.response;

	const requestData = body.data ?? {};
	let sinceDate: Date;
	if (requestData.since !== undefined) {
		if (typeof requestData.since !== 'string') return badRequest('since must be a string');
		sinceDate = new Date(requestData.since);
		if (Number.isNaN(sinceDate.getTime())) return badRequest('since must be a valid ISO date string');
	} else {
		sinceDate = new Date(Date.now() - DEFAULT_WINDOW_MS);
	}

	const rows = await fetchDailyDigestItems(sinceDate.toISOString(), [...DAILY_COLLECTION_ROUTES]);
	await sendDailyDigest(
		env,
		rows.map((row) => ({
			title: row.title,
			externalUrl: row.externalUrl,
			sourceName: row.sourceName ?? topic.site.name,
			kind: row.kind,
		})),
		sinceDate,
	);

	return jsonResponse({ data: { sent: rows.length, since: sinceDate.toISOString() } }, 201);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
