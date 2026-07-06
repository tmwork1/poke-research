// クエリパラメータのパース処理の回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseOptionalPositiveInteger, parsePositiveInteger } from '../src/lib/params.ts';

describe('parsePositiveInteger', () => {
	it('正の整数はそのまま返す', () => {
		assert.equal(parsePositiveInteger('3', 1), 3);
		assert.equal(parsePositiveInteger(20, 1), 20);
	});

	it('不正値はフォールバックへ倒す', () => {
		assert.equal(parsePositiveInteger('abc', 5), 5);
		assert.equal(parsePositiveInteger('-1', 5), 5);
		assert.equal(parsePositiveInteger('0', 5), 5);
		assert.equal(parsePositiveInteger('1.5', 5), 5);
		assert.equal(parsePositiveInteger(undefined, 5), 5);
	});
});

describe('parseOptionalPositiveInteger', () => {
	it('空値は undefined を返す', () => {
		assert.equal(parseOptionalPositiveInteger(null), undefined);
		assert.equal(parseOptionalPositiveInteger(''), undefined);
		assert.equal(parseOptionalPositiveInteger(undefined), undefined);
	});

	it('正の整数のみ受け付ける', () => {
		assert.equal(parseOptionalPositiveInteger('7'), 7);
		assert.equal(parseOptionalPositiveInteger('-2'), undefined);
		assert.equal(parseOptionalPositiveInteger('x'), undefined);
	});
});
