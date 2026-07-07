// catalog.ts の正規化・スコアリング補助（DB非依存の純粋関数）の回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildTagMonthlySeries,
	buildTrailingMonths,
	escapeIlikeToken,
	niceAxisMax,
	normalizeItem,
	tagUsageFromItems,
	type CatalogItem,
	type ItemRow,
	type TagUsage,
} from '../src/lib/catalog-normalize.ts';

describe('normalizeItem', () => {
	it('source/item_tags が単一オブジェクトの結合結果を正規化する', () => {
		const row: ItemRow = {
			id: 1,
			source: { id: 10, name: 'Qiita', type: 'qiita', origin_url: null },
			item_tags: [{ tag: { id: 100, name: 'ポケモン' } }],
		};
		const item = normalizeItem(row);
		assert.deepEqual(item.source, { id: 10, name: 'Qiita', type: 'qiita', origin_url: null });
		assert.deepEqual(item.tags, [{ id: 100, name: 'ポケモン' }]);
	});

	it('source/tag が配列で返ってきた場合は単一値へ落とす', () => {
		const row: ItemRow = {
			id: 2,
			source: [{ id: 10, name: 'Qiita', type: 'qiita', origin_url: null }],
			item_tags: [{ tag: [{ id: 100, name: 'ポケモン' }] }],
		};
		const item = normalizeItem(row);
		assert.deepEqual(item.source, { id: 10, name: 'Qiita', type: 'qiita', origin_url: null });
		assert.deepEqual(item.tags, [{ id: 100, name: 'ポケモン' }]);
	});

	it('source が無い/tag 欠損は空値として扱う', () => {
		const row: ItemRow = {
			id: 3,
			source: null,
			item_tags: [{ tag: null }, {}],
		};
		const item = normalizeItem(row);
		assert.equal(item.source, null);
		assert.deepEqual(item.tags, []);
	});

	it('item_tags が配列でない場合はタグ無しとして扱う', () => {
		const row: ItemRow = { id: 4 };
		const item = normalizeItem(row);
		assert.deepEqual(item.tags, []);
	});
});

describe('escapeIlikeToken', () => {
	it('ILIKE のワイルドカードをエスケープしたうえで前後に % を付ける', () => {
		assert.equal(escapeIlikeToken('abc'), '"%abc%"');
		assert.equal(escapeIlikeToken('50%'), '"%50\\%%"');
		assert.equal(escapeIlikeToken('a_b'), '"%a\\_b%"');
	});

	it('二重引用符も安全にエスケープする', () => {
		assert.equal(escapeIlikeToken('"quoted"'), '"%\\"quoted\\"%"');
	});
});

describe('tagUsageFromItems', () => {
	it('タグごとの出現数を集計し、多い順・同数なら名前順で返す', () => {
		const items: CatalogItem[] = [
			{ id: 1, tags: [{ id: 1, name: 'b' }, { id: 2, name: 'a' }] },
			{ id: 2, tags: [{ id: 1, name: 'b' }] },
			{ id: 3, tags: [{ id: 2, name: 'a' }, { id: 3, name: 'c' }] },
		];
		const usage = tagUsageFromItems(items);
		assert.deepEqual(usage.map((t) => [t.name, t.count]), [
			['a', 2],
			['b', 2],
			['c', 1],
		]);
	});

	it('タグが無いアイテムのみの場合は空配列を返す', () => {
		const items: CatalogItem[] = [{ id: 1, tags: [] }];
		assert.deepEqual(tagUsageFromItems(items), []);
	});
});

describe('buildTrailingMonths', () => {
	it('現在の月を含む直近N ヶ月分を古い順(YYYY-MM)で返す', () => {
		const now = new Date(2026, 6, 15); // 2026-07-15
		assert.deepEqual(buildTrailingMonths(3, now), ['2026-05', '2026-06', '2026-07']);
	});

	it('年をまたぐ場合も正しく繰り下がる', () => {
		const now = new Date(2026, 1, 1); // 2026-02-01
		assert.deepEqual(buildTrailingMonths(3, now), ['2025-12', '2026-01', '2026-02']);
	});
});

describe('buildTagMonthlySeries', () => {
	it('タグ×月ごとに件数を揃え、該当行が無い月は0で埋める', () => {
		const tags: TagUsage[] = [
			{ id: 1, name: 'ポケモン', count: 5 },
			{ id: 2, name: '図鑑', count: 2 },
		];
		const months = ['2026-05', '2026-06', '2026-07'];
		const rows = [
			{ tag_id: 1, month: '2026-05-01', count: 2 },
			{ tag_id: 1, month: '2026-07-01', count: 3 },
			{ tag_id: 2, month: '2026-06-01', count: 1 },
		];
		const series = buildTagMonthlySeries(tags, months, rows);
		assert.deepEqual(series, [
			{ id: 1, name: 'ポケモン', counts: [2, 0, 3] },
			{ id: 2, name: '図鑑', counts: [0, 1, 0] },
		]);
	});

	it('タグが無い場合は空配列を返す', () => {
		assert.deepEqual(buildTagMonthlySeries([], ['2026-07'], []), []);
	});
});

describe('niceAxisMax', () => {
	it('0以下は1を返す', () => {
		assert.equal(niceAxisMax(0), 1);
		assert.equal(niceAxisMax(-3), 1);
	});

	it('1/2/5刻みの目盛りで割り切れる値へ切り上げる', () => {
		assert.equal(niceAxisMax(4), 4);
		assert.equal(niceAxisMax(7), 8);
		assert.equal(niceAxisMax(9), 10);
		assert.equal(niceAxisMax(23), 30);
	});
});
