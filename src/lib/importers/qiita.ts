// Qiita API から記事を収集し、AI レビューとタグ同期を通して DB に反映する。
// 収集条件や provenance も metadata に残して、再現できる形で保存する。
import { normalizeTagName, reviewImportArticle } from './article-ai';
import { getSupabaseClient } from '../supabase';
import { parsePositiveInteger } from '../params';

const QIITA_API_URL = 'https://qiita.com/api/v2/items';
const QIITA_SOURCE_NAME = 'Qiita';
const QIITA_SOURCE_ORIGIN_URL = 'https://qiita.com/';
const DEFAULT_KIND = 'article';
const DEFAULT_QUERY = 'ポケモン';
const MAX_AI_BODY_CHARS = 4000;

interface QiitaUser {
	id: string;
	name?: string | null;
	url_name?: string | null;
}

interface QiitaItem {
	id: string;
	title: string;
	url: string;
	rendered_body?: string | null;
	body?: string | null;
	created_at: string;
	updated_at: string;
	likes_count?: number;
	comments_count?: number;
	page_views_count?: number;
	private?: boolean;
	coediting?: boolean;
	user: QiitaUser;
	tags?: Array<{ name?: string | null }>;
}

export interface QiitaSyncOptions {
	query?: string;
	pages?: number;
	perPage?: number;
	token?: string;
}

export interface QiitaSyncResult {
	query: string;
	pages: number;
	perPage: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	sourceId: number;
	fetchedAt: string;
	items: Array<{
		id: number | null;
		action: 'inserted' | 'updated' | 'skipped';
		externalUrl: string;
		title: string;
		reason?: string;
	}>;
}

interface UpsertResult<T> {
	row: T;
	action: 'inserted' | 'updated' | 'skipped';
}

interface SourceRow {
	id: number;
}

interface ItemRow {
	id: number;
}

function normalizeQuery(query?: string): string {
	const trimmed = query?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUERY;
}

function stripHtml(value: string): string {
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

function createSummary(item: QiitaItem): string {
	// 本文が取れない場合はタイトルだけでも最低限の説明になるようにする。
	const body = item.rendered_body ?? item.body ?? '';
	const text = stripHtml(body);
	if (!text) {
		return item.title;
	}
	return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function createAuthors(item: QiitaItem): string[] {
	const author = item.user.name?.trim() || item.user.url_name?.trim() || item.user.id.trim();
	return author ? [author] : [];
}

function extractTags(item: QiitaItem): string[] {
	return [...new Set((item.tags ?? []).map((tag) => tag.name?.trim()).filter((tag): tag is string => Boolean(tag)))];
}

function createSourceMetadata(query: string, fetchedAt: string, perPage: number, pages: number) {
	// 取得条件は source metadata に残し、後から再現可能にしておく。
	return {
		service: 'qiita',
		api_url: QIITA_API_URL,
		origin_url: QIITA_SOURCE_ORIGIN_URL,
		collection: {
			query,
			per_page: perPage,
			pages,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(item: QiitaItem, query: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	// 取り込み元、再取得条件、AI 判定結果を 1 つのメタデータにまとめる。
	return {
		service: 'qiita',
		qiita: {
			id: item.id,
			likes_count: item.likes_count ?? 0,
			comments_count: item.comments_count ?? 0,
			page_views_count: item.page_views_count ?? 0,
			private: item.private ?? false,
			coediting: item.coediting ?? false,
			tags: extractTags(item),
		},
		provenance: {
			source: 'qiita-importer',
			query,
			fetched_at: fetchedAt,
			qiita_id: item.id,
			qiita_url: item.url,
			qiita_updated_at: item.updated_at,
		},
		ai: {
			model: aiReview.model,
			accepted: aiReview.accepted,
			reason: aiReview.reason,
			confidence: aiReview.confidence ?? null,
			summary: aiReview.summary,
			tags: aiReview.tags,
		},
	};
}

function createAiBodyExcerpt(item: QiitaItem): string {
	// 長すぎる本文は OpenAI 送信用に切り詰めて、コストと応答の安定性を守る。
	const body = item.rendered_body ?? item.body ?? '';
	const text = stripHtml(body);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
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

async function syncItemTags(itemId: number, tagNames: string[]): Promise<void> {
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

async function fetchQiitaPage(query: string, page: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	const url = new URL(QIITA_API_URL);
	url.searchParams.set('query', query);
	url.searchParams.set('page', String(page));
	url.searchParams.set('per_page', String(perPage));

	const headers: HeadersInit = {
		'User-Agent': 'pokemon-research-qiita-importer',
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(url, { headers });
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Qiita API request failed (${response.status}): ${detail}`);
	}

	return (await response.json()) as QiitaItem[];
}

async function fetchQiitaItems(query: string, pages: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	// 複数ページ取得時に同一 URL が再登場しても、1 件だけ残す。
	const results: QiitaItem[] = [];
	const seen = new Set<string>();

	for (let page = 1; page <= pages; page += 1) {
		const items = await fetchQiitaPage(query, page, perPage, token);
		if (items.length === 0) {
			break;
		}

		for (const item of items) {
			if (seen.has(item.url)) {
				continue;
			}
			seen.add(item.url);
			results.push(item);
		}

		if (items.length < perPage) {
			break;
		}
	}

	return results;
}

async function upsertSource(query: string, fetchedAt: string, pages: number, perPage: number): Promise<SourceRow> {
	// select してから insert/update する形は同時実行時に重複行を作りうるため、
	// origin_url の UNIQUE 制約(migrations/002)を前提に upsert で原子的に処理する。
	const supabase = await getSupabaseClient();
	const metadata = createSourceMetadata(query, fetchedAt, perPage, pages);

	const { data, error } = await supabase
		.from('sources')
		.upsert(
			{
				name: QIITA_SOURCE_NAME,
				type: 'qiita',
				origin_url: QIITA_SOURCE_ORIGIN_URL,
				metadata,
			},
			{ onConflict: 'origin_url' },
		)
		.select('id')
		.single();
	if (error) throw error;
	return data as SourceRow;
}

async function upsertItem(
	sourceId: number,
	item: QiitaItem,
	query: string,
	fetchedAt: string,
	review: Awaited<ReturnType<typeof reviewImportArticle>>,
): Promise<UpsertResult<ItemRow>> {
	const supabase = await getSupabaseClient();
	const metadata = createItemMetadata(item, query, fetchedAt, review);
	const tags = review.tags.length > 0 ? review.tags : extractTags(item);
	const payload = {
		source_id: sourceId,
		external_url: item.url,
		kind: DEFAULT_KIND,
		title: item.title,
		authors: createAuthors(item),
		summary: review.summary,
		published_at: item.created_at,
		updated_at: item.updated_at,
		metadata,
		version: item.updated_at,
	};

	// action の判定は結果表示用の分類に過ぎず、書き込み自体は external_url の
	// UNIQUE 制約(migrations/002)を前提にした upsert で原子的に行う。
	const { data: existingItems, error: selectError } = await supabase
		.from('items')
		.select('id')
		.eq('external_url', item.url)
		.limit(1);
	if (selectError) throw selectError;
	const action: 'inserted' | 'updated' = existingItems?.length ? 'updated' : 'inserted';

	const { data: upserted, error: upsertError } = await supabase
		.from('items')
		.upsert(payload, { onConflict: 'external_url' })
		.select('id')
		.single();
	if (upsertError) throw upsertError;

	const itemId = (upserted as ItemRow).id;
	await syncItemTags(itemId, tags);
	return { row: { id: itemId }, action };
}

const IMPORT_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
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

async function processQiitaItem(
	item: QiitaItem,
	sourceId: number,
	query: string,
	fetchedAt: string,
): Promise<QiitaSyncResult['items'][number] & { action: 'inserted' | 'updated' | 'skipped' }> {
	// 1件の失敗がバッチ全体を止めないよう、記事単位で例外を吸収して skipped として積む。
	try {
		const review = await reviewImportArticle({
			sourceName: QIITA_SOURCE_NAME,
			query,
			title: item.title,
			url: item.url,
			authors: createAuthors(item),
			sourceTags: extractTags(item),
			createdAt: item.created_at,
			updatedAt: item.updated_at,
			bodyExcerpt: createAiBodyExcerpt(item),
		});
		if (!review.accepted) {
			return {
				id: null,
				action: 'skipped',
				externalUrl: item.url,
				title: item.title,
				reason: review.reason,
			};
		}

		const result = await upsertItem(sourceId, item, query, fetchedAt, review);
		return {
			id: result.row.id,
			action: result.action,
			externalUrl: item.url,
			title: item.title,
		};
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl: item.url,
			title: item.title,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}

export async function syncQiitaCollection(options: QiitaSyncOptions = {}): Promise<QiitaSyncResult> {
	const query = normalizeQuery(options.query);
	const pages = parsePositiveInteger(options.pages, 1);
	const perPage = parsePositiveInteger(options.perPage, 20);
	const fetchedAt = new Date().toISOString();

	const [items, source] = await Promise.all([
		fetchQiitaItems(query, pages, perPage, options.token),
		upsertSource(query, fetchedAt, pages, perPage),
	]);

	const itemResults = await mapWithConcurrency(items, IMPORT_CONCURRENCY, (item) =>
		processQiitaItem(item, source.id, query, fetchedAt),
	);

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	for (const result of itemResults) {
		if (result.action === 'inserted') inserted += 1;
		else if (result.action === 'updated') updated += 1;
		else skipped += 1;
	}

	return {
		query,
		pages,
		perPage,
		fetched: items.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
