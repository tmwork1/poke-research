// catalog.ts から DB 非依存の純粋関数（正規化・スコアリング補助）だけを切り出したモジュール。
// cloudflare:workers を静的importする supabase.ts に依存しないため、node --test から直接読み込める。
import type { Annotation, Item, Source, Tag } from './db-types';

export type CatalogSource = Pick<Source, 'id' | 'name' | 'type' | 'origin_url'>;

export interface CatalogItem extends Item {
	source?: CatalogSource | null;
	tags: Tag[];
}

export interface ItemDetail extends CatalogItem {
	annotations: Annotation[];
}

export interface TagUsage extends Tag {
	count: number;
}

export interface SourceUsage extends Source {
	count: number;
}

export interface ItemRow extends Item {
	source?: CatalogSource | CatalogSource[] | null;
	item_tags?: Array<{ tag?: Tag | Tag[] | null }>;
}

export function normalizeSource(source: ItemRow['source']): CatalogSource | null {
	if (!source) return null;
	// Supabase の結合結果は単一オブジェクトか配列で返ることがあるため、
	// 画面側が扱いやすい単一値に正規化する。
	if (Array.isArray(source)) {
		return (source[0] as CatalogSource | undefined) ?? null;
	}
	return source;
}

export function normalizeTags(itemTags: ItemRow['item_tags']): Tag[] {
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

export function normalizeItem(row: ItemRow): CatalogItem {
	const { source, item_tags, ...item } = row;
	return {
		...item,
		source: normalizeSource(source),
		tags: normalizeTags(item_tags),
	};
}

export function escapeIlikeToken(token: string): string {
	// ILIKE のワイルドカード文字をエスケープしたうえで前後に % を付け、
	// PostgREST のフィルタ構文で特別扱いされる , . ( ) を避けるため二重引用符で囲む。
	const escapedWildcards = token.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/"/g, '\\"');
	return `"%${escapedWildcards}%"`;
}

export function tagUsageFromItems(items: CatalogItem[]): TagUsage[] {
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
