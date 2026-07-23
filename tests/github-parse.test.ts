// GitHub Search API レスポンス整形（github-parse.ts）の回帰テスト。
// github-parse.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// github.ts を経由せず直接ユニットテストできる（tests/openalex-parse.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildGithubSearchQuery,
	extractOwnerLogin,
	resolveTitle,
	selectExternalUrl,
	type GithubRepository,
} from '../src/lib/importers/github-parse.ts';

function makeRepo(overrides: Partial<GithubRepository> = {}): GithubRepository {
	return {
		id: 1,
		name: 'pokeapi',
		full_name: 'PokeAPI/pokeapi',
		html_url: 'https://github.com/PokeAPI/pokeapi',
		fork: false,
		stargazers_count: 5000,
		forks_count: 100,
		owner: { login: 'PokeAPI' },
		...overrides,
	};
}

describe('resolveTitle', () => {
	it('full_nameを返す', () => {
		assert.equal(resolveTitle(makeRepo()), 'PokeAPI/pokeapi');
	});
});

describe('selectExternalUrl', () => {
	it('html_urlを返す', () => {
		assert.equal(selectExternalUrl(makeRepo()), 'https://github.com/PokeAPI/pokeapi');
	});
});

describe('extractOwnerLogin', () => {
	it('owner.loginを配列に包んで返す', () => {
		assert.deepEqual(extractOwnerLogin(makeRepo({ owner: { login: 'PokeAPI' } })), ['PokeAPI']);
	});

	it('ownerが無ければ空配列を返す', () => {
		assert.deepEqual(extractOwnerLogin(makeRepo({ owner: null })), []);
	});

	it('owner.loginが無ければ空配列を返す', () => {
		assert.deepEqual(extractOwnerLogin(makeRepo({ owner: {} })), []);
	});
});

describe('buildGithubSearchQuery', () => {
	it('単一キーワードにfork:falseを付与する', () => {
		assert.equal(buildGithubSearchQuery(['pokemon']), 'pokemon fork:false');
	});

	it('複数キーワードは括弧+ORで結合する', () => {
		assert.equal(buildGithubSearchQuery(['pokemon', 'pokeapi']), '(pokemon OR pokeapi) fork:false');
	});

	it('キーワードが空ならfork:falseのみ返す', () => {
		assert.equal(buildGithubSearchQuery([]), 'fork:false');
	});

	it('空白のみのキーワードは除外する', () => {
		assert.equal(buildGithubSearchQuery(['pokemon', '  ']), 'pokemon fork:false');
	});
});
