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
	if (Array.isArray(source)) {
		return (source[0] as CatalogSource | undefined) ?? null;
	}
	return source;
}

function normalizeTags(itemTags: ItemRow['item_tags']): Tag[] {
	if (!Array.isArray(itemTags)) return [];
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

async function resolveItemIdsByTag(tagName: string): Promise<number[]> {
	const supabase = await getSupabaseClient();
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

export async function fetchCatalogItems(filters: ItemFilters = {}): Promise<CatalogItem[]> {
	const searchTerm = filters.q?.trim();
	const supabase = await getSupabaseClient();
	let query = supabase.from('items').select(ITEM_SELECT).order('created_at', { ascending: false });

	if (filters.sourceId !== undefined) {
		query = query.eq('source_id', filters.sourceId);
	}

	if (filters.kind?.trim()) {
		query = query.eq('kind', filters.kind.trim());
	}

	if (searchTerm) {
		query = query.textSearch('search_vector', searchTerm, { type: 'websearch', config: 'simple' });
	}

	if (filters.tag?.trim()) {
		const itemIds = await resolveItemIdsByTag(filters.tag.trim());
		if (itemIds.length === 0) return [];
		query = query.in('id', itemIds);
	}

	if (filters.limit && filters.limit > 0) {
		query = query.limit(filters.limit);
	}

	const { data, error } = await query;
	if (error) throw error;
	return ((data ?? []) as ItemRow[]).map(normalizeItem);
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
	const annotations = await fetchCatalogAnnotations(id);
	return {
		...item,
		annotations,
	};
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