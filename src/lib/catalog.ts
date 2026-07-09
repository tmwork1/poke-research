// 一覧・詳細表示向けに、items / sources / tags / annotations を組み合わせて読む。
// 結合結果の形を UI 側で扱いやすい形へ正規化する責務もここに置く（正規化の純粋関数自体は
// node --test から読み込めるよう catalog-normalize.ts に分離している）。
import { getSupabaseClient } from './supabase';
import type { Annotation, Tag } from './db-types';
import {
	buildTagMonthlySeries,
	buildTrailingMonths,
	escapeIlikeToken,
	filterItemsByKeyword,
	normalizeItem,
	tagUsageFromItems,
	type CatalogItem,
	type ItemDetail,
	type ItemRow,
	type SourceUsage,
	type TagTrendSeries,
	type TagUsage,
} from './catalog-normalize';

export type { CatalogItem, ItemDetail, SourceUsage, TagTrendSeries, TagUsage };

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

export interface CatalogItemsPage {
	items: CatalogItem[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
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

export async function resolveItemIdsByTag(tagName: string): Promise<number[]> {
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

export async function fetchCatalogSources(
	filters: Pick<ItemFilters, 'q' | 'tag' | 'tags' | 'since' | 'sourceIds' | 'kind'> = {},
): Promise<SourceUsage[]> {
	const supabase = await getSupabaseClient();
	// kind 絞り込み（技術記事/論文タブ）がある場合も、全件集計 RPC ではなく実件数を数える必要がある。
	const hasNarrowingFilters = Boolean(
		filters.q?.trim() || filters.tag || (filters.tags && filters.tags.length > 0) || filters.since || filters.kind?.trim(),
	);

	const [{ data, error }, countBySourceId] = await Promise.all([
		supabase.from('sources').select('*').order('created_at', { ascending: false }),
		// キーワード・タグ・期間の絞り込みが無ければ、全件集計 RPC の方が軽い。
		// 絞り込みがある場合は、それらの条件（sourceId 自体は除く）に一致する
		// アイテムを実際に数え、フィルタ結果0件のソースをボタンから除外する。
		hasNarrowingFilters ? countSourceMatches(filters) : countAllSources(supabase),
	]);
	if (error) throw error;

	const selectedSourceIds = new Set(filters.sourceIds ?? []);
	// ソースボタンは件数の多い順に並べる（同数はソース一覧の既定順=作成日時降順を維持）。
	// 現在選択中のソースは、他条件との組み合わせで0件になっても選択解除できるよう残す。
	return (data ?? [])
		.map((source) => ({ ...source, count: countBySourceId.get(source.id) ?? 0 }))
		.filter((source) => source.count > 0 || selectedSourceIds.has(source.id))
		.sort((a, b) => b.count - a.count);
}

async function countAllSources(supabase: Awaited<ReturnType<typeof getSupabaseClient>>): Promise<Map<number, number>> {
	const { data, error } = await supabase.rpc('source_item_counts');
	if (error) throw error;
	return new Map(
		((data ?? []) as Array<{ source_id: number; count: number | string }>).map((row) => [row.source_id, Number(row.count)]),
	);
}

async function countSourceMatches(filters: Pick<ItemFilters, 'q' | 'tag' | 'tags' | 'since' | 'kind'>): Promise<Map<number, number>> {
	const { data } = await queryCatalogItems({ ...filters, sourceIds: undefined }, { selectOverride: 'source_id' });
	const counts = new Map<number, number>();
	for (const row of data as unknown as Array<{ source_id: number | null }>) {
		if (row.source_id === null || row.source_id === undefined) continue;
		counts.set(row.source_id, (counts.get(row.source_id) ?? 0) + 1);
	}
	return counts;
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
	options: {
		withCount?: boolean;
		offset?: number;
		orderBy?: 'published_at' | 'bookmarks_count';
		includeBody?: boolean;
		/** ソース件数集計など、フル結合ではなく特定カラムだけ欲しい場合の select 差し替え。 */
		selectOverride?: string;
	} = {},
): Promise<{ data: ItemRow[]; count: number | null }> {
	const searchTerm = filters.q?.trim();
	const ascending = filters.order === 'asc';
	const supabase = await getSupabaseClient();
	let query = supabase
		.from('items')
		.select(options.selectOverride ?? (options.includeBody ? ITEM_SELECT_WITH_BODY : ITEM_SELECT), options.withCount ? { count: 'exact' } : undefined);

	// リンク切れ検出（migrations/016）で broken と確定したアイテムは、検索・タグ・新着などの
	// 一覧（RSS/サイトマップも fetchCatalogItems 経由のため同様）から隠す。詳細ページ（
	// fetchCatalogItemById）やブックマーク一覧は別クエリのため対象外のまま残す。
	query = query.neq('link_status', 'broken');

	// AIレビューで棄却された記事（migrations/018）も偽陰性レビューのため items には保存するが、
	// 一覧・検索からは link_status と同様の考え方で隠す。詳細ページ・ブックマーク一覧は対象外。
	query = query.eq('ai_accepted', true);

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

export async function fetchTopTags(limit = 20, kind?: string): Promise<TagUsage[]> {
	// 集計は DB 側の RPC（migrations/012 の top_tags、migrations/023 で kind_filter 引数を追加）で
	// 行い、行の全取得を避ける。kind を省略した場合は従来どおり記事・論文を横断した全件集計になる。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.rpc('top_tags', { tag_limit: limit, kind_filter: kind ?? null });
	if (error) throw error;

	return ((data ?? []) as Array<{ id: number; name: string; count: number | string }>).map((row) => ({
		id: row.id,
		name: row.name,
		count: Number(row.count),
	}));
}

export interface TagTrend {
	months: string[];
	series: TagTrendSeries[];
}

const TAG_TREND_MONTHS = 6;

export async function fetchTagTrend(tags: TagUsage[], monthsBack = TAG_TREND_MONTHS): Promise<TagTrend> {
	const months = buildTrailingMonths(monthsBack);
	if (tags.length === 0) return { months, series: [] };

	// 集計は DB 側の RPC（migrations/020 の tag_monthly_counts）で行い、行の全取得を避ける。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.rpc('tag_monthly_counts', {
		target_tag_ids: tags.map((tag) => tag.id),
		months_back: monthsBack,
	});
	if (error) throw error;

	const rows = ((data ?? []) as Array<{ tag_id: number; month: string; count: number | string }>).map((row) => ({
		tag_id: row.tag_id,
		month: row.month,
		count: Number(row.count),
	}));

	return { months, series: buildTagMonthlySeries(tags, months, rows) };
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

export interface BookmarkedItemsResult {
	items: CatalogItem[];
	availableTags: TagUsage[];
	total: number;
}

export async function fetchBookmarkedItemsFiltered(
	userId: string,
	options: { tag?: string; sort?: CatalogSort; q?: string } = {},
): Promise<BookmarkedItemsResult> {
	const items = await fetchBookmarkedItems(userId);
	const availableTags = tagUsageFromItems(items);
	const byTag = options.tag ? items.filter((item) => item.tags.some((tag) => tag.name === options.tag)) : items;
	const filtered = options.q ? filterItemsByKeyword(byTag, options.q) : byTag;

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

const DEFAULT_RELATED_LIMIT = 4;

/**
 * あるアイテムのタグ集合（呼び出し側が渡す tagIds）を基準に、item_tags の重なりが多い順・
 * 同数なら新しい順で他のアイテムを返す。タグ重複ベースのヒューリスティックのみで完結させる。
 * excludeItemIds には呼び出し元がすでに表示中のアイテム（例: 起点タグの一覧に載る全アイテム）
 * を渡し、同じ記事が二重に出るのを防ぐ。
 */
export async function fetchRelatedItems(
	excludeItemIds: number[],
	tagIds: number[],
	options: { limit?: number } = {},
): Promise<CatalogItem[]> {
	const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_RELATED_LIMIT;
	if (tagIds.length === 0) return [];

	const supabase = await getSupabaseClient();
	let itemTagQuery = supabase.from('item_tags').select('item_id, tag_id').in('tag_id', tagIds);
	if (excludeItemIds.length > 0) {
		itemTagQuery = itemTagQuery.not('item_id', 'in', `(${excludeItemIds.join(',')})`);
	}
	const { data: itemTagRows, error: itemTagError } = await itemTagQuery;
	if (itemTagError) throw itemTagError;

	// 一致タグ数はアイテムごとに JS 側で集計する（PostgREST では集約 + 上位N件抽出が難しいため）。
	const overlapCounts = new Map<number, number>();
	for (const row of itemTagRows ?? []) {
		overlapCounts.set(row.item_id, (overlapCounts.get(row.item_id) ?? 0) + 1);
	}
	if (overlapCounts.size === 0) return [];

	const { data: itemRows, error: itemsError } = await supabase
		.from('items')
		.select(ITEM_SELECT)
		.in('id', [...overlapCounts.keys()]);
	if (itemsError) throw itemsError;

	const items = (itemRows ?? []).map((row) => normalizeItem(row as ItemRow));
	items.sort((a, b) => {
		const overlapDiff = (overlapCounts.get(b.id) ?? 0) - (overlapCounts.get(a.id) ?? 0);
		if (overlapDiff !== 0) return overlapDiff;
		const aTime = new Date(a.published_at ?? a.created_at).getTime();
		const bTime = new Date(b.published_at ?? b.created_at).getTime();
		return bTime - aTime;
	});

	return items.slice(0, limit);
}