// 複数の収集元（Qiita/Zenn/...）で共通する DB 書き込み・並列実行処理をまとめる。
// ソース固有のフィールドマッピングは各インポーター側に残し、ここでは汎用部分だけを扱う。
import { normalizeTagName, type ImportArticleReview } from './article-ai';
import { getSupabaseClient } from '../supabase';

export function stripHtml(value: string): string {
	// AI への入力や要約生成でノイズになりやすいタグを先に除去する。
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

export async function mapWithConcurrency<T, R>(
	inputs: T[],
	limit: number,
	fn: (input: T) => Promise<R>,
): Promise<R[]> {
	// 記事ごとの OpenAI 呼び出しと DB 書き込みを、限られた同時実行数で並列化する。
	const results: R[] = new Array(inputs.length);
	let cursor = 0;

	async function worker() {
		while (cursor < inputs.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await fn(inputs[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
	return results;
}

async function ensureTags(tagNames: string[]): Promise<Map<string, number>> {
	// 既存タグを先に引き、足りないタグだけをまとめて作成する。
	const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
	const tagIdMap = new Map<string, number>();
	if (normalizedTagNames.length === 0) return tagIdMap;

	const supabase = await getSupabaseClient();
	const { data: existingTags, error: selectError } = await supabase.from('tags').select('id, name').in('name', normalizedTagNames);
	if (selectError) throw selectError;

	for (const tag of existingTags ?? []) {
		tagIdMap.set(tag.name, tag.id);
	}

	const missingTagNames = normalizedTagNames.filter((tagName) => !tagIdMap.has(tagName));
	if (missingTagNames.length > 0) {
		const { error: insertError } = await supabase
			.from('tags')
			.insert(missingTagNames.map((name) => ({ name })));
		if (insertError && insertError.code !== '23505') throw insertError;

		const { data: refreshedTags, error: refreshError } = await supabase
			.from('tags')
			.select('id, name')
			.in('name', normalizedTagNames);
		if (refreshError) throw refreshError;

		for (const tag of refreshedTags ?? []) {
			tagIdMap.set(tag.name, tag.id);
		}
	}

	return tagIdMap;
}

export async function syncItemTags(itemId: number, tagNames: string[]): Promise<void> {
	// 全削除→再作成だと失敗時にタグが失われたまま残るため、差分だけ insert/delete する。
	const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
	const supabase = await getSupabaseClient();

	const tagIdMap = await ensureTags(normalizedTagNames);
	const desiredTagIds = new Set(
		normalizedTagNames
			.map((tagName) => tagIdMap.get(tagName))
			.filter((tagId): tagId is number => typeof tagId === 'number'),
	);

	const { data: existingRelations, error: selectError } = await supabase
		.from('item_tags')
		.select('tag_id')
		.eq('item_id', itemId);
	if (selectError) throw selectError;
	const existingTagIds = new Set((existingRelations ?? []).map((relation) => relation.tag_id));

	const toInsert = [...desiredTagIds]
		.filter((tagId) => !existingTagIds.has(tagId))
		.map((tagId) => ({ item_id: itemId, tag_id: tagId }));
	if (toInsert.length > 0) {
		const { error: insertError } = await supabase.from('item_tags').insert(toInsert);
		if (insertError) throw insertError;
	}

	const toDelete = [...existingTagIds].filter((tagId) => !desiredTagIds.has(tagId));
	if (toDelete.length > 0) {
		const { error: deleteError } = await supabase
			.from('item_tags')
			.delete()
			.eq('item_id', itemId)
			.in('tag_id', toDelete);
		if (deleteError) throw deleteError;
	}
}

export interface SourceUpsertPayload {
	name: string;
	type: string;
	originUrl: string;
	metadata: Record<string, unknown>;
}

export async function upsertSourceByOriginUrl(payload: SourceUpsertPayload): Promise<{ id: number }> {
	// select してから insert/update する形は同時実行時に重複行を作りうるため、
	// origin_url の UNIQUE 制約(migrations/002)を前提に upsert で原子的に処理する。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('sources')
		.upsert(
			{ name: payload.name, type: payload.type, origin_url: payload.originUrl, metadata: payload.metadata },
			{ onConflict: 'origin_url' },
		)
		.select('id')
		.single();
	if (error) throw error;
	return data as { id: number };
}

export interface ItemUpsertPayload {
	sourceId: number;
	externalUrl: string;
	kind: string;
	title: string;
	authors: string[];
	summary: string;
	publishedAt: string | null;
	updatedAt: string | null;
	metadata: Record<string, unknown>;
	version: string;
}

export async function upsertItemByExternalUrl(
	payload: ItemUpsertPayload,
	tags: string[],
): Promise<{ id: number; action: 'inserted' | 'updated' }> {
	// action の判定は結果表示用の分類に過ぎず、書き込み自体は external_url の
	// UNIQUE 制約(migrations/002)を前提にした upsert で原子的に行う。
	const supabase = await getSupabaseClient();
	const { data: existingItems, error: selectError } = await supabase
		.from('items')
		.select('id')
		.eq('external_url', payload.externalUrl)
		.limit(1);
	if (selectError) throw selectError;
	const action: 'inserted' | 'updated' = existingItems?.length ? 'updated' : 'inserted';

	const { data: upserted, error: upsertError } = await supabase
		.from('items')
		.upsert(
			{
				source_id: payload.sourceId,
				external_url: payload.externalUrl,
				kind: payload.kind,
				title: payload.title,
				authors: payload.authors,
				summary: payload.summary,
				published_at: payload.publishedAt,
				updated_at: payload.updatedAt,
				metadata: payload.metadata,
				version: payload.version,
			},
			{ onConflict: 'external_url' },
		)
		.select('id')
		.single();
	if (upsertError) throw upsertError;

	const itemId = (upserted as { id: number }).id;
	await syncItemTags(itemId, tags);
	return { id: itemId, action };
}

export interface ImportItemOutcome {
	id: number | null;
	action: 'inserted' | 'updated' | 'skipped';
	externalUrl: string;
	title: string;
	reason?: string;
}

export async function processImportItem(
	externalUrl: string,
	title: string,
	review: () => Promise<ImportArticleReview>,
	upsert: (review: ImportArticleReview) => Promise<{ id: number; action: 'inserted' | 'updated' }>,
): Promise<ImportItemOutcome> {
	// 1件の失敗がバッチ全体を止めないよう、記事単位で例外を吸収して skipped として積む。
	try {
		const result = await review();
		if (!result.accepted) {
			return { id: null, action: 'skipped', externalUrl, title, reason: result.reason };
		}

		const upserted = await upsert(result);
		return { id: upserted.id, action: upserted.action, externalUrl, title };
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl,
			title,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}
