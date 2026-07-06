// リンク切れ判定（decideLinkStatus）の状態遷移の回帰テスト。
// DB I/O を持たない純粋関数として切り出してあるため、fetch をモックせずに検証できる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideLinkStatus } from '../src/lib/link-status.ts';

const CHECKED_AT = '2026-07-06T00:00:00.000Z';

describe('decideLinkStatus', () => {
	it('健全なリンクは checked_at だけ更新する', () => {
		const decision = decideLinkStatus({ link_status: 'ok', link_broken_since: null }, false, CHECKED_AT);
		assert.equal(decision.outcome, 'ok');
		assert.deepEqual(decision.update, { link_checked_at: CHECKED_AT });
	});

	it('初回の到達不能は疑いとして記録するだけで broken にはしない', () => {
		const decision = decideLinkStatus({ link_status: 'ok', link_broken_since: null }, true, CHECKED_AT);
		assert.equal(decision.outcome, 'suspect');
		assert.deepEqual(decision.update, { link_checked_at: CHECKED_AT, link_broken_since: CHECKED_AT });
	});

	it('疑い状態で再度到達不能なら broken に確定する', () => {
		const decision = decideLinkStatus({ link_status: 'ok', link_broken_since: '2026-06-29T00:00:00.000Z' }, true, CHECKED_AT);
		assert.equal(decision.outcome, 'broken');
		assert.deepEqual(decision.update, { link_status: 'broken', link_checked_at: CHECKED_AT });
	});

	it('疑い状態で回復したら疑いを解消する', () => {
		const decision = decideLinkStatus({ link_status: 'ok', link_broken_since: '2026-06-29T00:00:00.000Z' }, false, CHECKED_AT);
		assert.equal(decision.outcome, 'recovered');
		assert.deepEqual(decision.update, { link_status: 'ok', link_checked_at: CHECKED_AT, link_broken_since: null });
	});

	it('broken 確定済みが回復したら ok に戻す', () => {
		const decision = decideLinkStatus({ link_status: 'broken', link_broken_since: '2026-06-20T00:00:00.000Z' }, false, CHECKED_AT);
		assert.equal(decision.outcome, 'recovered');
		assert.deepEqual(decision.update, { link_status: 'ok', link_checked_at: CHECKED_AT, link_broken_since: null });
	});

	it('broken 確定済みがまだ到達不能なら checked_at のみ更新する', () => {
		const decision = decideLinkStatus({ link_status: 'broken', link_broken_since: '2026-06-20T00:00:00.000Z' }, true, CHECKED_AT);
		assert.equal(decision.outcome, 'unchanged');
		assert.deepEqual(decision.update, { link_checked_at: CHECKED_AT });
	});
});
