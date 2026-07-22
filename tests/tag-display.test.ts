// タグ表示ラベル整形の回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatTagLabel } from '../src/lib/tag-display.ts';

describe('formatTagLabel', () => {
	it('既知語は公式表記へ変換する', () => {
		assert.equal(formatTagLabel('python'), 'Python');
		assert.equal(formatTagLabel('pokeapi'), 'PokeAPI');
	});

	it('未知の英字語は先頭大文字にする', () => {
		assert.equal(formatTagLabel('flask'), 'Flask');
	});

	it('日本語タグはそのまま返す', () => {
		assert.equal(formatTagLabel('ポケモンカード'), 'ポケモンカード');
	});

	it('複合語は単語単位で整形する', () => {
		assert.equal(formatTagLabel('github actions'), 'GitHub Actions');
		assert.equal(formatTagLabel('restful api'), 'RESTful API');
	});

	it('略語・固有表記はタグ全体一致で正しい大文字小文字にする', () => {
		assert.equal(formatTagLabel('rag'), 'RAG');
		assert.equal(formatTagLabel('scikit-learn'), 'scikit-learn');
		assert.equal(formatTagLabel('gorilla-mux'), 'gorilla/mux');
		assert.equal(formatTagLabel('watsonx'), 'watsonx');
		assert.equal(formatTagLabel('macos'), 'macOS');
	});
});
