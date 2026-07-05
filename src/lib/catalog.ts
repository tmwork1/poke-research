// 一覧・詳細表示向けに、items / sources / tags / annotations を組み合わせて読む。
// 結合結果の形を UI 側で扱いやすい形へ正規化する責務もここに置く。
import { getSupabaseClient } from './supabase';
import type { Annotation, Item, Source, Tag } from './db-types';

type CatalogSource = Pick<Source, 'id' | 'name' | 'type' | 'origin_url'>;

export interface CatalogItem extends Item {
	source?: CatalogSource | null;
	tags: Tag[];
}

export interface ItemDetail extends CatalogItem {
	annotations: Annotation[];
}

export interface ItemFilters {
	q?: string;
	kind?: string;
	tag?: string;
	sourceId?: number;
	limit?: number;
}

export interface TagUsage extends Tag {
	count: number;
}

export interface CatalogItemsPage {
	items: CatalogItem[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

interface ItemRow extends Item {
	source?: CatalogSource | CatalogSource[] | null;
	item_tags?: Array<{ tag?: Tag | Tag[] | null }>;
}

const ITEM_SELECT = `
	id,
	source_id,
	external_url,
	kind,
	title,
	authors,
	summary,
	published_at,
	updated_at,
	metadata,
	version,
	created_at,
	source:sources (
		id,
		name,
		type,
		origin_url
	),
	item_tags (
		tag:tags (
			id,
			name
		)
	)
`;

function normalizeSource(source: ItemRow['source']): CatalogSource | null {
	if (!source) return null;
	// Supabase の結合結果は単一オブジェクトか配列で返ることがあるため、
	// 画面側が扱いやすい単一値に正規化する。
	if (Array.isArray(source)) {
		return (source[0] as CatalogSource | undefined) ?? null;
	}
	return source;
}

function normalizeTags(itemTags: ItemRow['item_tags']): Tag[] {
	if (!Array.isArray(itemTags)) return [];
	// 結合先の欠損や重複を吸収して、タグ一覧だけを安全に取り出す。
	return itemTags.flatMap((entry) => {
		const rawTag = entry?.tag;
		if (!rawTag) return [];
		if (Array.isArray(rawTag)) {
			return rawTag.filter((tag): tag is Tag => Boolean(tag?.id && tag?.name));
		}
		return rawTag.id && rawTag.name ? [rawTag] : [];
	});
}

function normalizeItem(row: ItemRow): CatalogItem {
	const { source, item_tags, ...item } = row;
	return {
		...item,
		source: normalizeSource(source),
		tags: normalizeTags(item_tags),
	};
}

function escapeIlikeToken(token: string): string {
	// ILIKE のワイルドカード文字をエスケープしたうえで前後に % を付け、
	// PostgREST のフィルタ構文で特別扱いされる , . ( ) を避けるため二重引用符で囲む。
	const escapedWildcards = token.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/"/g, '\\"');
	return `"%${escapedWildcards}%"`;
}

async function resolveItemIdsByTag(tagName: string): Promise<number[]> {
	const supabase = await getSupabaseClient();
	// タグ名から item_id を引くために、まず tag_id をまとめて解決する。
	const { data: tags, error } = await supabase.from('tags').select('id').eq('name', tagName);
	if (error) throw error;
	const tagIds = (tags ?? []).map((tag) => tag.id);
	if (tagIds.length === 0) return [];

	const { data: itemTags, error: itemTagError } = await supabase
		.from('item_tags')
		.select('item_id')
		.in('tag_id', tagIds);
	if (itemTagError) throw itemTagError;

	return [...new Set((itemTags ?? []).map((row) => row.item_id))];
}

export async function fetchCatalogTags(): Promise<Tag[]> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('tags').select('id, name').order('name', { ascending: true });
	if (error) throw error;
	return data ?? [];
}

export async function fetchCatalogSources(): Promise<Source[]> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('sources').select('*').order('created_at', { ascending: false });
	if (error) throw error;
	return data ?? [];
}

export async function fetchCatalogAnnotations(itemId?: number): Promise<Annotation[]> {
	const supabase = await getSupabaseClient();
	let query = supabase.from('annotations').select('*').order('created_at', { ascending: false });
	if (itemId !== undefined) {
		query = query.eq('item_id', itemId);
	}
	const { data, error } = await query;
	if (error) throw error;
	return data ?? [];
}

async function queryCatalogItems(
	filters: ItemFilters,
	options: { withCount?: boolean; offset?: number } = {},
): Promise<{ data: ItemRow[]; count: number | null }> {
	const searchTerm = filters.q?.trim();
	const supabase = await getSupabaseClient();
	let query = supabase
		.from('items')
		.select(ITEM_SELECT, options.withCount ? { count: 'exact' } : undefined)
		.order('published_at', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false });

	if (filters.sourceId !== undefined) {
		query = query.eq('source_id', filters.sourceId);
	}

	if (filters.kind?.trim()) {
		query = query.eq('kind', filters.kind.trim());
	}

	if (searchTerm) {
		// 日本語は分かち書きされていないため、全文検索(tsvector)ではなく
		// タイトル・要約への部分一致(ILIKE)をトークンごとにAND条件で積む。
		const tokens = searchTerm.split(/\s+/).filter((token) => token.length > 0);
		for (const token of tokens) {
			const pattern = escapeIlikeToken(token);
			query = query.or(`title.ilike.${pattern},summary.ilike.${pattern}`);
		}
	}

	if (filters.tag?.trim()) {
		// タグ条件は join の曖昧さを避けるため、先に item_id の集合へ落とす。
		const itemIds = await resolveItemIdsByTag(filters.tag.trim());
		if (itemIds.length === 0) return { data: [], count: 0 };
		query = query.in('id', itemIds);
	}

	if (filters.limit && filters.limit > 0) {
		if (options.offset && options.offset > 0) {
			query = query.range(options.offset, options.offset + filters.limit - 1);
		} else {
			query = query.limit(filters.limit);
		}
	}

	const { data, error, count } = await query;
	if (error) throw error;
	return { data: (data ?? []) as ItemRow[], count: count ?? null };
}

export async function fetchCatalogItems(filters: ItemFilters = {}): Promise<CatalogItem[]> {
	const { data } = await queryCatalogItems(filters);
	return data.map(normalizeItem);
}

const DEFAULT_PAGE_SIZE = 20;

export async function fetchCatalogItemsPage(
	filters: ItemFilters & { page?: number; pageSize?: number } = {},
): Promise<CatalogItemsPage> {
	const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : DEFAULT_PAGE_SIZE;
	const page = filters.page && filters.page > 0 ? filters.page : 1;
	const offset = (page - 1) * pageSize;

	const { data, count } = await queryCatalogItems(
		{ ...filters, limit: pageSize },
		{ withCount: true, offset },
	);

	const total = count ?? data.length;
	return {
		items: data.map(normalizeItem),
		total,
		page,
		pageSize,
		totalPages: Math.max(1, Math.ceil(total / pageSize)),
	};
}

export async function fetchTopTags(limit = 20): Promise<TagUsage[]> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('item_tags').select('tag:tags(id, name)');
	if (error) throw error;

	const counts = new Map<number, TagUsage>();
	for (const row of (data ?? []) as Array<{ tag?: Tag | Tag[] | null }>) {
		const rawTag = row.tag;
		const tags = Array.isArray(rawTag) ? rawTag : rawTag ? [rawTag] : [];
		for (const tag of tags) {
			if (!tag?.id || !tag?.name) continue;
			const existing = counts.get(tag.id);
			if (existing) {
				existing.count += 1;
			} else {
				counts.set(tag.id, { id: tag.id, name: tag.name, count: 1 });
			}
		}
	}

	return [...counts.values()]
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, limit);
}

export async function fetchCatalogItemById(id: number): Promise<ItemDetail | null> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('items')
		.select(ITEM_SELECT)
		.eq('id', id)
		.maybeSingle();
	if (error) throw error;
	if (!data) return null;

	const item = normalizeItem(data as ItemRow);
	// 詳細表示では item 本体とは別クエリで注釈を付ける。
	const annotations = await fetchCatalogAnnotations(id);
	return {
		...item,
		annotations,
	};
}

export async function fetchBookmarkedItemIds(userId: string): Promise<Set<number>> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('bookmarks').select('item_id').eq('user_id', userId);
	if (error) throw error;
	return new Set((data ?? []).map((row) => row.item_id));
}

interface BookmarkRow {
	item?: ItemRow | ItemRow[] | null;
}

export async function fetchBookmarkedItems(userId: string): Promise<CatalogItem[]> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('bookmarks')
		.select(`item:items (${ITEM_SELECT})`)
		.eq('user_id', userId)
		.order('created_at', { ascending: false });
	if (error) throw error;

	return (data ?? []).flatMap((row: BookmarkRow) => {
		const item = Array.isArray(row.item) ? row.item[0] : row.item;
		return item ? [normalizeItem(item)] : [];
	});
}

export async function fetchCatalogOverview() {
	const [items, tags, sources, annotations] = await Promise.all([
		fetchCatalogItems({ limit: 6 }),
		fetchCatalogTags(),
		fetchCatalogSources(),
		fetchCatalogAnnotations(),
	]);

	return {
		items,
		tags,
		sources,
		annotations,
	};
}