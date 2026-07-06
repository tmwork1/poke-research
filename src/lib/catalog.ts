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

export type SortOrder = 'asc' | 'desc';

export interface ItemFilters {
	q?: string;
	kind?: string;
	tag?: string;
	/** 複数タグの AND 絞り込み。tag と併用された場合は両方を条件に含める。 */
	tags?: string[];
	sourceIds?: number[];
	/** 公開日の下限（ISO 8601）。期間フィルタ用。 */
	since?: string;
	limit?: number;
	order?: SortOrder;
}

export type CatalogSort = 'new' | 'oldest' | 'popular' | 'relevance';
const RELEVANCE_SORT_CANDIDATE_POOL = 300;
// タイトル一致は要約一致より強いシグナルとして重み付けする。
const RELEVANCE_TITLE_WEIGHT = 3;
const RELEVANCE_SUMMARY_WEIGHT = 1;
// 本文一致は要約一致と同じ「本文中に言及がある」シグナルとして同重み扱いにする
// （本文は新規収集分にしか無く null のことも多いため、タイトル・要約より強くはしない）。
const RELEVANCE_BODY_WEIGHT = 1;

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
	bookmarks_count,
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

// 関連度順ソートの本文スコアリングにのみ使う select。body は最大2万字と大きいため、
// 通常の一覧表示（ITEM_SELECT）には含めず必要な時だけ追加取得する。
const ITEM_SELECT_WITH_BODY = `${ITEM_SELECT},\n\tbody\n`;

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
	options: { withCount?: boolean; offset?: number; orderBy?: 'published_at' | 'bookmarks_count'; includeBody?: boolean } = {},
): Promise<{ data: ItemRow[]; count: number | null }> {
	const searchTerm = filters.q?.trim();
	const ascending = filters.order === 'asc';
	const supabase = await getSupabaseClient();
	let query = supabase
		.from('items')
		.select(options.includeBody ? ITEM_SELECT_WITH_BODY : ITEM_SELECT, options.withCount ? { count: 'exact' } : undefined);

	if (options.orderBy === 'bookmarks_count') {
		// 人気順: bookmarks_count 降順を主キーに、公開日時降順を同数時のタイブレークにする。
		query = query
			.order('bookmarks_count', { ascending: false })
			.order('published_at', { ascending: false, nullsFirst: false })
			.order('created_at', { ascending: false });
	} else {
		query = query
			.order('published_at', { ascending, nullsFirst: false })
			.order('created_at', { ascending });
	}

	if (filters.sourceIds && filters.sourceIds.length > 0) {
		query = query.in('source_id', filters.sourceIds);
	}

	if (filters.kind?.trim()) {
		query = query.eq('kind', filters.kind.trim());
	}

	if (filters.since) {
		query = query.gte('published_at', filters.since);
	}

	if (searchTerm) {
		// 日本語は分かち書きされていないため、全文検索(tsvector)ではなく
		// タイトル・要約・本文への部分一致(ILIKE)をトークンごとにAND条件で積む。
		// 本文(migrations/015)は新規収集分にのみ入るため、古いアイテムは body が null で
		// 一致しないだけで、条件自体は安全に共存できる。
		const tokens = searchTerm.split(/\s+/).filter((token) => token.length > 0);
		for (const token of tokens) {
			const pattern = escapeIlikeToken(token);
			query = query.or(`title.ilike.${pattern},summary.ilike.${pattern},body.ilike.${pattern}`);
		}
	}

	const tagNames = [...new Set([...(filters.tags ?? []), ...(filters.tag ? [filters.tag] : [])].map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
	if (tagNames.length > 0) {
		// タグ条件は join の曖昧さを避けるため、先に item_id の集合へ落とす。
		// 複数タグは AND（全タグが付いたアイテムのみ）として積集合を取る。
		let itemIds: Set<number> | null = null;
		for (const tagName of tagNames) {
			const ids = new Set(await resolveItemIdsByTag(tagName));
			itemIds = itemIds === null ? ids : new Set([...itemIds].filter((id) => ids.has(id)));
			if (itemIds.size === 0) return { data: [], count: 0 };
		}
		query = query.in('id', [...(itemIds ?? [])]);
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
	filters: ItemFilters & { page?: number; pageSize?: number; sort?: CatalogSort } = {},
): Promise<CatalogItemsPage> {
	const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : DEFAULT_PAGE_SIZE;
	const page = filters.page && filters.page > 0 ? filters.page : 1;

	const searchTerm = filters.q?.trim();
	if (filters.sort === 'relevance' && searchTerm) {
		// 検索クエリ(ILIKE)は一致した行しか返さないため「どこに・いくつ一致したか」の強さが
		// 並びに反映されない。人気順と同じく直近の候補プールを取得し、タイトル一致 > 要約一致 ≒ 本文一致の
		// 重み付けでJS側にてスコアリングする（プールは日付降順なので同点時は新しい順になる）。
		// 本文はスコアリングのためだけに候補プール分を追加取得する（一覧表示には使わない）。
		const tokens = searchTerm.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
		const { data } = await queryCatalogItems({ ...filters, limit: RELEVANCE_SORT_CANDIDATE_POOL }, { includeBody: true });
		const candidates = data.map(normalizeItem);
		const scored = candidates.map((item, index) => {
			const title = (item.title ?? '').toLowerCase();
			const summary = (item.summary ?? '').toLowerCase();
			const body = (item.body ?? '').toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (title.includes(token)) score += RELEVANCE_TITLE_WEIGHT;
				if (summary.includes(token)) score += RELEVANCE_SUMMARY_WEIGHT;
				if (body.includes(token)) score += RELEVANCE_BODY_WEIGHT;
			}
			return { item, index, score };
		});
		scored.sort((a, b) => b.score - a.score || a.index - b.index);

		const total = scored.length;
		const offset = (page - 1) * pageSize;
		return {
			items: scored.slice(offset, offset + pageSize).map((entry) => entry.item),
			total,
			page,
			pageSize,
			totalPages: Math.max(1, Math.ceil(total / pageSize)),
		};
	}

	if (filters.sort === 'popular') {
		// 人気順は items.bookmarks_count（migrations/013 のトリガーで維持されるキャッシュ列）を
		// DB側で降順ソートし、通常のページングと同様に range で取得する。全件が対象になる。
		const offset = (page - 1) * pageSize;
		const { data, count } = await queryCatalogItems(
			{ ...filters, limit: pageSize },
			{ withCount: true, offset, orderBy: 'bookmarks_count' },
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

	// 古い順は新着順の逆順として扱う（DB側の並び替え方向を反転するだけ）。
	const order: SortOrder = filters.sort === 'oldest' ? 'asc' : 'desc';
	const offset = (page - 1) * pageSize;
	const { data, count } = await queryCatalogItems(
		{ ...filters, order, limit: pageSize },
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
	// 集計は DB 側の RPC（migrations/012 の top_tags）で行い、行の全取得を避ける。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.rpc('top_tags', { tag_limit: limit });
	if (error) throw error;

	return ((data ?? []) as Array<{ id: number; name: string; count: number | string }>).map((row) => ({
		id: row.id,
		name: row.name,
		count: Number(row.count),
	}));
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

export async function fetchBookmarkCounts(itemIds: number[]): Promise<Map<number, number>> {
	const counts = new Map<number, number>();
	if (itemIds.length === 0) return counts;

	const supabase = await getSupabaseClient();
	// 集計は DB 側の RPC（migrations/012 の bookmark_counts）で行い、行の全取得を避ける。
	const { data, error } = await supabase.rpc('bookmark_counts', { target_item_ids: itemIds });
	if (error) throw error;

	for (const row of (data ?? []) as Array<{ item_id: number; count: number | string }>) {
		counts.set(row.item_id, Number(row.count));
	}
	return counts;
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

const RECOMMENDATION_CANDIDATE_POOL = 100;
const RECOMMENDATION_TAG_WEIGHT = 3;

function tagUsageFromItems(items: CatalogItem[]): TagUsage[] {
	const counts = new Map<number, TagUsage>();
	for (const item of items) {
		for (const tag of item.tags) {
			const existing = counts.get(tag.id);
			if (existing) {
				existing.count += 1;
			} else {
				counts.set(tag.id, { id: tag.id, name: tag.name, count: 1 });
			}
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface BookmarkedItemsResult {
	items: CatalogItem[];
	availableTags: TagUsage[];
	total: number;
}

export async function fetchBookmarkedItemsFiltered(
	userId: string,
	options: { tag?: string; sort?: CatalogSort } = {},
): Promise<BookmarkedItemsResult> {
	const items = await fetchBookmarkedItems(userId);
	const availableTags = tagUsageFromItems(items);
	const filtered = options.tag ? items.filter((item) => item.tags.some((tag) => tag.name === options.tag)) : items;

	let ordered: CatalogItem[];
	if (options.sort === 'oldest') {
		// fetchBookmarkedItems はブックマーク日時の降順で返すため、反転すれば古い順になる。
		ordered = [...filtered].reverse();
	} else if (options.sort === 'popular') {
		const bookmarkCounts = await fetchBookmarkCounts(filtered.map((item) => item.id));
		ordered = [...filtered].sort((a, b) => (bookmarkCounts.get(b.id) ?? 0) - (bookmarkCounts.get(a.id) ?? 0));
	} else {
		ordered = filtered;
	}

	return { items: ordered, availableTags, total: items.length };
}

export async function fetchRecommendedItems(userId: string, limit = 6): Promise<CatalogItem[]> {
	const bookmarkedItemIds = await fetchBookmarkedItemIds(userId);

	let preferredTagIds = new Set<number>();
	if (bookmarkedItemIds.size > 0) {
		const bookmarkedItems = await fetchBookmarkedItems(userId);
		preferredTagIds = new Set(bookmarkedItems.flatMap((item) => item.tags.map((tag) => tag.id)));
	}

	const { data } = await queryCatalogItems({ limit: RECOMMENDATION_CANDIDATE_POOL });
	const candidates = data.map(normalizeItem).filter((item) => !bookmarkedItemIds.has(item.id));
	if (candidates.length === 0) return [];

	const bookmarkCounts = await fetchBookmarkCounts(candidates.map((item) => item.id));
	const scored = candidates.map((item) => {
		const tagOverlap = item.tags.reduce((count, tag) => count + (preferredTagIds.has(tag.id) ? 1 : 0), 0);
		const popularity = bookmarkCounts.get(item.id) ?? 0;
		return { item, score: tagOverlap * RECOMMENDATION_TAG_WEIGHT + popularity };
	});
	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, limit).map((entry) => entry.item);
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