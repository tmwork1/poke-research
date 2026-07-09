// ブログ収集（Brave Search）のキーワード巡回ロジックの回帰テスト。
// resolveBlogKeywordIndex は cloudflare:workers 等の外部依存を持たない純粋関数のため、
// blog.ts を経由せず直接ユニットテストできる（process-import-item.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBlogKeywordIndex } from '../src/lib/importers/blog-rotation.ts';

const SLOT_MS = 4 * 60 * 60 * 1000; // BLOG_CRON の発火間隔（4時間）と同じ値

describe('resolveBlogKeywordIndex', () => {
	it('発火間隔ぶん時刻が進むと、通し番号がちょうど1つ進む', () => {
		const t0 = Date.parse('2026-07-09T01:00:00.000Z');
		const idx0 = resolveBlogKeywordIndex(t0, SLOT_MS, 6);
		const idx1 = resolveBlogKeywordIndex(t0 + SLOT_MS, SLOT_MS, 6);
		assert.equal((idx0 + 1) % 6, idx1);
	});

	it('キーワード数を超えて一巡すると先頭に戻る', () => {
		const t0 = Date.parse('2026-07-09T01:00:00.000Z');
		const indices = Array.from({ length: 6 }, (_, i) => resolveBlogKeywordIndex(t0 + i * SLOT_MS, SLOT_MS, 6));
		assert.deepEqual(indices, [indices[0], (indices[0] + 1) % 6, (indices[0] + 2) % 6, (indices[0] + 3) % 6, (indices[0] + 4) % 6, (indices[0] + 5) % 6]);
		const next = resolveBlogKeywordIndex(t0 + 6 * SLOT_MS, SLOT_MS, 6);
		assert.equal(next, indices[0]);
	});

	it('キーワード数が変わっても（コード変更なしに）巡回範囲が追従する', () => {
		const t0 = Date.parse('2026-07-09T01:00:00.000Z');
		const idxWith8 = resolveBlogKeywordIndex(t0, SLOT_MS, 8);
		assert.ok(idxWith8 >= 0 && idxWith8 < 8);
	});
});
