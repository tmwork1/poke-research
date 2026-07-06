// processImportItem（AIレビュー結果を受けて upsert を呼び出す共通ロジック）の回帰テスト。
// 案A（migrations/018）で棄却記事も items に保存するようになったため、棄却時にも upsert が
// 呼ばれること・タグ同期相当がスキップされる呼び出し形になっていることを確認する。
// process-import-item.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// common.ts を経由せず直接ユニットテストできる（keywords.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { processImportItem } from '../src/lib/importers/process-import-item.ts';

describe('processImportItem', () => {
	it('採用時は upsert を呼び、action/id を upsert の結果に合わせる', async () => {
		const upsertCalls: unknown[] = [];
		const outcome = await processImportItem(
			'https://example.com/a',
			'title-a',
			async () => ({ accepted: true, reason: '' }),
			async (review) => {
				upsertCalls.push(review);
				return { id: 1, action: 'inserted' as const };
			},
		);

		assert.equal(upsertCalls.length, 1);
		assert.deepEqual(outcome, { id: 1, action: 'inserted', externalUrl: 'https://example.com/a', title: 'title-a' });
	});

	it('棄却時も upsert が呼ばれ items に保存される（案A）が、action は skipped のまま', async () => {
		const upsertCalls: unknown[] = [];
		const outcome = await processImportItem(
			'https://example.com/b',
			'title-b',
			async () => ({ accepted: false, reason: 'ポケモンと無関係' }),
			async (review) => {
				upsertCalls.push(review);
				return { id: 2, action: 'inserted' as const };
			},
		);

		// upsert が呼ばれた = 棄却記事でも DB へ保存されたことを示す。
		assert.equal(upsertCalls.length, 1);
		assert.deepEqual(upsertCalls[0], { accepted: false, reason: 'ポケモンと無関係' });
		// 後方互換のため action は従来どおり 'skipped'、reason も引き継ぐ。id は保存先の実IDになる。
		assert.deepEqual(outcome, {
			id: 2,
			action: 'skipped',
			externalUrl: 'https://example.com/b',
			title: 'title-b',
			reason: 'ポケモンと無関係',
		});
	});

	it('タグ同期のスキップ判断は upsert 側の責務: 棄却時は upsert コールバックに accepted=false が渡る', async () => {
		let syncTagsSkipped: boolean | null = null;
		await processImportItem(
			'https://example.com/c',
			'title-c',
			async () => ({ accepted: false, reason: 'no' }),
			async (review) => {
				// 呼び出し側（各インポーター）は review.accepted を見て syncTags: false を渡す実装なので、
				// ここでは upsert コールバックに正しく accepted=false が伝わることだけを検証する。
				syncTagsSkipped = review.accepted === false;
				return { id: 3, action: 'updated' as const };
			},
		);

		assert.equal(syncTagsSkipped, true);
	});

	it('review が例外を投げた場合は upsert を呼ばず、保存せず skipped を返す', async () => {
		let upsertCalled = false;
		const outcome = await processImportItem(
			'https://example.com/d',
			'title-d',
			async () => {
				throw new Error('OpenAI request failed (500): boom');
			},
			async () => {
				upsertCalled = true;
				return { id: 4, action: 'inserted' as const };
			},
		);

		assert.equal(upsertCalled, false);
		assert.deepEqual(outcome, {
			id: null,
			action: 'skipped',
			externalUrl: 'https://example.com/d',
			title: 'title-d',
			reason: 'OpenAI request failed (500): boom',
		});
	});

	it('upsert が例外を投げた場合も skipped として吸収し、id は null のままにする', async () => {
		const outcome = await processImportItem(
			'https://example.com/e',
			'title-e',
			async () => ({ accepted: true, reason: '' }),
			async () => {
				throw new Error('db error');
			},
		);

		assert.deepEqual(outcome, {
			id: null,
			action: 'skipped',
			externalUrl: 'https://example.com/e',
			title: 'title-e',
			reason: 'db error',
		});
	});
});
