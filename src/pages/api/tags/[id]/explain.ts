// タグ名の難易度判定とAI解説を返す読み取り専用API。
// 結果は tags テーブルにキャッシュされるため、同じタグへの2回目以降の呼び出しはAIを呼ばない。
import type { APIContext } from 'astro';
import { jsonResponse, methodNotAllowed, notFound, parseIdParam } from '../../_shared';
import { getSupabaseClient } from '../../../../lib/supabase';
import { explainTag } from '../../../../lib/tag-explain';

export const prerender = false;

export async function GET({ params }: APIContext) {
	const id = parseIdParam(params);
	if (id === null) return notFound();

	const supabase = await getSupabaseClient();
	const { data: tag, error } = await supabase.from('tags').select('id, name').eq('id', id).maybeSingle();
	if (error) throw error;
	if (!tag) return notFound();

	const result = await explainTag(tag.id, tag.name);
	return jsonResponse({ data: result });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
