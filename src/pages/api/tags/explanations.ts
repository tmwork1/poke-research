// タグ解説のバッチ取得API。
// カードに並ぶ複数タグの解説を1回のリクエストでまとめて返すための読み取り専用エンドポイント。
// キャッシュ済み（explained_at が入っている）タグのみを返し、OpenAI 生成は行わない。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed } from '../_shared';
import { getSupabaseClient } from '../../../lib/supabase';

export const prerender = false;

const MAX_IDS = 50;

interface TagExplanationRow {
	id: number;
	is_difficult: boolean | null;
	explanation: string | null;
	explained_at: string | null;
}

function parseIds(raw: string | null): number[] | null {
	if (!raw) return [];
	const parts = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
	const ids: number[] = [];
	for (const part of parts) {
		const id = Number(part);
		if (!Number.isInteger(id) || id <= 0) return null;
		ids.push(id);
	}
	return ids;
}

export async function GET({ url }: APIContext) {
	const ids = parseIds(url.searchParams.get('ids'));
	if (ids === null) return badRequest('ids must be a comma-separated list of positive integers');
	if (ids.length > MAX_IDS) return badRequest(`ids must contain at most ${MAX_IDS} values`);

	if (ids.length === 0) {
		return jsonResponse({ data: {} });
	}

	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('tags')
		.select('id, is_difficult, explanation, explained_at')
		.in('id', ids);
	if (error) throw error;

	const rows = (data ?? []) as TagExplanationRow[];
	const result: Record<string, { isDifficult: boolean; explanation: string | null }> = {};
	for (const row of rows) {
		if (!row.explained_at) continue;
		result[String(row.id)] = {
			isDifficult: Boolean(row.is_difficult),
			explanation: row.explanation ?? null,
		};
	}

	return jsonResponse({ data: result });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
