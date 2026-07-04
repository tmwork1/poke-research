import { normalizeTagName, reviewImportArticle } from './article-ai';
import { getSupabaseClient } from '../supabase';

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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value && value > 0 ? value : fallback;
}

function stripHtml(value: string): string {
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
	const body = item.rendered_body ?? item.body ?? '';
	const text = stripHtml(body);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
}

async function ensureTags(tagNames: string[]): Promise<Map<string, number>> {
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
	const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
	const supabase = await getSupabaseClient();

	const { error: deleteError } = await supabase.from('item_tags').delete().eq('item_id', itemId);
	if (deleteError) throw deleteError;

	if (normalizedTagNames.length === 0) return;

	const tagIdMap = await ensureTags(normalizedTagNames);
	const relations = normalizedTagNames
		.map((tagName) => tagIdMap.get(tagName))
		.filter((tagId): tagId is number => typeof tagId === 'number')
		.map((tagId) => ({ item_id: itemId, tag_id: tagId }));

	if (relations.length === 0) return;

	const { error: insertError } = await supabase.from('item_tags').insert(relations);
	if (insertError) throw insertError;
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
	const supabase = await getSupabaseClient();
	const metadata = createSourceMetadata(query, fetchedAt, perPage, pages);

	const { data: sources, error: selectError } = await supabase
		.from('sources')
		.select('id')
		.eq('origin_url', QIITA_SOURCE_ORIGIN_URL)
		.limit(1);
	if (selectError) throw selectError;

	if (sources?.length) {
		const sourceId = sources[0].id;
		const { error: updateError } = await supabase
			.from('sources')
			.update({
				name: QIITA_SOURCE_NAME,
				type: 'qiita',
				origin_url: QIITA_SOURCE_ORIGIN_URL,
				metadata,
			})
			.eq('id', sourceId);
		if (updateError) throw updateError;
		return { id: sourceId };
	}

	const { data: inserted, error: insertError } = await supabase
		.from('sources')
		.insert([
			{
				name: QIITA_SOURCE_NAME,
				type: 'qiita',
				origin_url: QIITA_SOURCE_ORIGIN_URL,
				metadata,
			},
		])
		.select('id')
		.single();
	if (insertError) throw insertError;
	return inserted as SourceRow;
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

	const { data: existingItems, error: selectError } = await supabase
		.from('items')
		.select('id')
		.eq('external_url', item.url)
		.limit(1);
	if (selectError) throw selectError;

	if (existingItems?.length) {
		const itemId = existingItems[0].id;
		const { error: updateError } = await supabase.from('items').update(payload).eq('id', itemId);
		if (updateError) throw updateError;
		await syncItemTags(itemId, tags);
		return { row: { id: itemId }, action: 'updated' };
	}

	const { data: inserted, error: insertError } = await supabase
		.from('items')
		.insert([payload])
		.select('id')
		.single();
	if (insertError) throw insertError;
	await syncItemTags((inserted as ItemRow).id, tags);
	return { row: inserted as ItemRow, action: 'inserted' };
}

export async function syncQiitaCollection(options: QiitaSyncOptions = {}): Promise<QiitaSyncResult> {
	const query = normalizeQuery(options.query);
	const pages = normalizePositiveInteger(options.pages, 1);
	const perPage = normalizePositiveInteger(options.perPage, 20);
	const fetchedAt = new Date().toISOString();

	const [items, source] = await Promise.all([
		fetchQiitaItems(query, pages, perPage, options.token),
		upsertSource(query, fetchedAt, pages, perPage),
	]);

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	const itemResults: QiitaSyncResult['items'] = [];

	for (const item of items) {
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
			skipped += 1;
			itemResults.push({
				id: null,
				action: 'skipped',
				externalUrl: item.url,
				title: item.title,
				reason: review.reason,
			});
			continue;
		}

		const result = await upsertItem(source.id, item, query, fetchedAt, review);
		if (result.action === 'inserted') inserted += 1;
		if (result.action === 'updated') updated += 1;
		if (result.action === 'skipped') skipped += 1;
		itemResults.push({
			id: result.row.id,
			action: result.action,
			externalUrl: item.url,
			title: item.title,
		});
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
