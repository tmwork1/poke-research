// catalog.ts の正規化・スコアリング補助（DB非依存の純粋関数）の回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	escapeIlikeToken,
	normalizeItem,
	tagUsageFromItems,
	type CatalogItem,
	type ItemRow,
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
