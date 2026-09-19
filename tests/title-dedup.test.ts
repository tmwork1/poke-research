import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTitleForDedup } from '../src/lib/importers/title-dedup.ts';

test('記号・空白・大小文字の違いを吸収する', () => {
	// 実データ（OpenAlex経由のZenodo同一レコード）で観測した表記ゆれ。
	assert.equal(
		normalizeTitleForDedup('Data and code for "How predictable are augmented reality games?"'),
		normalizeTitleForDedup('Data and Code for "How Predictable are Augmented Reality Games? "'),
	);
	assert.equal(
		normalizeTitleForDedup('The POKEMON Speckle Survey of Nearby M dwarfs. IV. Distance-Limited Catalog'),
		normalizeTitleForDedup('The POKEMON Speckle Survey of Nearby M Dwarfs. IV. Distance-limited Catalog'),
	);
});

test('日本語のタイトルも英数字と同様に保持する', () => {
	assert.equal(normalizeTitleForDedup('ポケモンで学ぶ　統計学'), 'ポケモンで学ぶ統計学');
	assert.equal(normalizeTitleForDedup('【5分でできる】ターミナル'), '5分でできるターミナル');
});

test('囲み数字（①②）はPostgreSQLの[:alnum:]と同様に除去する（migrations/031の生成列と一致させる）', () => {
	assert.equal(normalizeTitleForDedup('【ポケモン×Java】Lv10：『選べ』〜メソッド②〜'), 'ポケモンjavalv10選べメソッド');
	assert.equal(normalizeTitleForDedup('①ポケモンカード傷検知'), 'ポケモンカード傷検知');
});

test('別タイトルは一致しない', () => {
	assert.notEqual(normalizeTitleForDedup('Pokemon team building Step1'), normalizeTitleForDedup('Pokemon team building Step2'));
});

test('空・未定義は空文字になる（重複判定の対象外にできる）', () => {
	assert.equal(normalizeTitleForDedup(''), '');
	assert.equal(normalizeTitleForDedup(null), '');
	assert.equal(normalizeTitleForDedup(undefined), '');
	assert.equal(normalizeTitleForDedup('   —  '), '');
});
