// ブログ収集（Brave Search）のドメイン除外・検索キーワード定義の回帰テスト。
// keywords.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// blog.ts を経由せず直接ユニットテストできる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BLOG_KEYWORDS, EXCLUDED_BLOG_DOMAINS, FILTERED_BLOG_DOMAINS, isExcludedBlogDomain, POKEMON_KEYWORDS } from '../src/lib/importers/keywords.ts';

describe('isExcludedBlogDomain', () => {
	it('EXCLUDED_BLOG_DOMAINS に載っているサービス・企業攻略サイトを除外する', () => {
		assert.equal(isExcludedBlogDomain('qiita.com'), true);
		assert.equal(isExcludedBlogDomain('yakkun.com'), true);
		assert.equal(isExcludedBlogDomain('gamewith.jp'), true);
	});

	it('サブドメインも除外する（www. は正規化してから判定する）', () => {
		assert.equal(isExcludedBlogDomain('www.qiita.com'), true);
		assert.equal(isExcludedBlogDomain('blog.gamewith.jp'), true);
	});

	it('FILTERED_BLOG_DOMAINS（フィルタのみのドメイン）も除外する', () => {
		assert.equal(isExcludedBlogDomain('b.hatena.ne.jp'), true);
		assert.equal(isExcludedBlogDomain('jp.pinterest.com'), true);
		assert.equal(isExcludedBlogDomain('sourceforge.net'), true);
		assert.equal(isExcludedBlogDomain('play.google.com'), true);
		assert.equal(isExcludedBlogDomain('apps.apple.com'), true);
	});

	it('b.hatena.ne.jp を除外しても hatenablog.com 系の個人ブログは除外しない', () => {
		assert.equal(isExcludedBlogDomain('example.hatenablog.com'), false);
		assert.equal(isExcludedBlogDomain('example.hatenablog.jp'), false);
	});

	it('除外リストに無い個人ブログ・テックブログのドメインは除外しない', () => {
		assert.equal(isExcludedBlogDomain('example.com'), false);
		assert.equal(isExcludedBlogDomain('tech-blog.example.dev'), false);
	});
});

describe('POKEMON_KEYWORDS', () => {
	it('無関係な技術記事・論文のノイズ源と判明した「pokeapi」は含まない（2026-07-10除外）', () => {
		assert.ok(!POKEMON_KEYWORDS.includes('pokeapi' as (typeof POKEMON_KEYWORDS)[number]));
	});
});

describe('BLOG_KEYWORDS', () => {
	it('Brave Search課金対策のため、Qiita/note等が使うPOKEMON_KEYWORDSより絞った独立リストである', () => {
		assert.ok(BLOG_KEYWORDS.length < POKEMON_KEYWORDS.length);
	});
});

describe('EXCLUDED_BLOG_DOMAINS / FILTERED_BLOG_DOMAINS', () => {
	it('両リストにドメインの重複が無い', () => {
		const excluded = new Set(EXCLUDED_BLOG_DOMAINS);
		const overlap = FILTERED_BLOG_DOMAINS.filter((domain) => excluded.has(domain));
		assert.deepEqual(overlap, []);
	});
});
