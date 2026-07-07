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

export interface TagTrendSeries {
	id: number;
	name: string;
	counts: number[];
}

/** 現在の月を含む直近 count ヶ月分の 'YYYY-MM' を古い順で返す。 */
export function buildTrailingMonths(count: number, now: Date = new Date()): string[] {
	const months: string[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
		months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
	}
	return months;
}

/** RPC の集計結果（tag_id・month・count の行）を、タグごと・月ごとに揃えた系列へ組み立てる。
 *  該当行が無い月は 0 件として埋め、折れ線が途切れないようにする。 */
export function buildTagMonthlySeries(
	tags: TagUsage[],
	months: string[],
	rows: Array<{ tag_id: number; month: string; count: number }>,
): TagTrendSeries[] {
	const countsByTag = new Map<number, Map<string, number>>();
	for (const row of rows) {
		const monthKey = row.month.slice(0, 7);
		if (!countsByTag.has(row.tag_id)) countsByTag.set(row.tag_id, new Map());
		countsByTag.get(row.tag_id)!.set(monthKey, row.count);
	}

	return tags.map((tag) => ({
		id: tag.id,
		name: tag.name,
		counts: months.map((month) => countsByTag.get(tag.id)?.get(month) ?? 0),
	}));
}

/** グラフのY軸上限を、目盛りが割り切れるきりの良い値（1/2/5刻み）に切り上げる。 */
export function niceAxisMax(max: number): number {
	if (max <= 0) return 1;
	const rawStep = max / 4;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const normalized = rawStep / magnitude;
	const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	const step = niceNormalized * magnitude;
	return Math.ceil(max / step) * step;
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

/** ブックマーク一覧のキーワード検索。DB検索（ILIKE）と同じ「トークンごとのAND・タイトル/要約いずれかに部分一致」を
 *  JS側で行う。取得済みの少数のアイテム集合を絞り込む用途のため、都度クエリせず既存データに対して行う。 */
export function filterItemsByKeyword<T extends { title?: string | null; summary?: string | null }>(items: T[], query: string): T[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return items;
	return items.filter((item) => {
		const haystack = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
}
