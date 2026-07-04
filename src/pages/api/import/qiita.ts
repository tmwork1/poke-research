// Qiita 収集ジョブを API 経由で起動するエンドポイント。
// デフォルトの検索条件は環境変数から読み、POST では上書きを受け付ける。
import { env } from 'cloudflare:workers';

import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { syncQiitaCollection } from '../../../lib/importers/qiita';

export const prerender = false;

interface QiitaImportRequest {
	query?: string;
	pages?: number;
	perPage?: number;
	token?: string;
}

function parsePositiveInteger(value: string | number | null | undefined, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value ?? NaN);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readDefaultQuery(): string {
	return env.QIITA_QUERY?.trim() || 'ポケモン';
}

function readDefaultPages(): number {
	return parsePositiveInteger(env.QIITA_PAGES, 1);
}

function readDefaultPerPage(): number {
	return parsePositiveInteger(env.QIITA_PER_PAGE, 20);
}

function readDefaultToken(): string | undefined {
	return env.QIITA_TOKEN?.trim() || undefined;
}

export async function GET() {
	return jsonResponse({
		data: {
			provider: 'qiita',
			query: readDefaultQuery(),
			pages: readDefaultPages(),
			perPage: readDefaultPerPage(),
			hasToken: Boolean(readDefaultToken()),
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

	const result = await syncQiitaCollection({
		query: requestData.query?.trim() || readDefaultQuery(),
		pages: parsePositiveInteger(requestData.pages, readDefaultPages()),
		perPage: parsePositiveInteger(requestData.perPage, readDefaultPerPage()),
		token: requestData.token?.trim() || readDefaultToken(),
	});

	return jsonResponse({ data: result }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
