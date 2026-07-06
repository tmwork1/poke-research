// 検索ハイライトの分割ロジックの回帰テスト。
// Node 24 の型ストリッピングで TypeScript のまま node --test 実行する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitForHighlight, tokenizeQuery } from '../src/lib/highlight.ts';

describe('tokenizeQuery', () => {
	it('空白区切りでトークン化し空要素を落とす', () => {
		assert.deepEqual(tokenizeQuery('  ポケカ  AI '), ['ポケカ', 'AI']);
		assert.deepEqual(tokenizeQuery(''), []);
		assert.deepEqual(tokenizeQuery(null), []);
	});
});

describe('splitForHighlight', () => {
	it('一致箇所を hit セグメントとして分割する', () => {
		const segments = splitForHighlight('ポケカのAI対戦', ['ポケカ']);
		assert.deepEqual(segments, [
			{ text: 'ポケカ', hit: true },
			{ text: 'のAI対戦', hit: false },
		]);
	});

	it('大文字小文字を無視して一致する', () => {
		const segments = splitForHighlight('Pokemon API guide', ['api']);
		assert.equal(segments.filter((seg) => seg.hit).length, 1);
		assert.equal(segments.find((seg) => seg.hit)?.text, 'API');
	});

	it('複数トークンをそれぞれ強調する', () => {
		const segments = splitForHighlight('ポケカとダメージ計算の話', ['ポケカ', 'ダメージ計算']);
		assert.deepEqual(segments.filter((seg) => seg.hit).map((seg) => seg.text), ['ポケカ', 'ダメージ計算']);
	});

	it('トークンなしなら全体を非強調で返す', () => {
		assert.deepEqual(splitForHighlight('text', []), [{ text: 'text', hit: false }]);
	});

	it('分割結果を結合すると元のテキストに戻る', () => {
		const text = 'ポケモンのポケカとpokeapiの記事';
		const segments = splitForHighlight(text, ['ポケカ', 'pokeapi', 'ポケモン']);
		assert.equal(segments.map((seg) => seg.text).join(''), text);
	});
});
