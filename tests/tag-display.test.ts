// タグ表示ラベル整形の回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatTagLabel } from '../src/lib/tag-display.ts';

describe('formatTagLabel', () => {
	it('既知語は公式表記へ変換する', () => {
		assert.equal(formatTagLabel('python'), 'Python');
		assert.equal(formatTagLabel('pokeapi'), 'PokeAPI');
		assert.equal(formatTagLabel('romハック'), 'ROMハック');
	});

	it('未知の英字語は先頭大文字にする', () => {
		assert.equal(formatTagLabel('flask'), 'Flask');
	});

	it('日本語タグはそのまま返す', () => {
		assert.equal(formatTagLabel('ポケモンカード'), 'ポケモンカード');
	});

	it('複合語は単語単位で整形する', () => {
		assert.equal(formatTagLabel('github actions'), 'GitHub Actions');
	});
});
