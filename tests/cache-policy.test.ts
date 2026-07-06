// 匿名アクセス向け Cache-Control 判定ロジックの回帰テスト。
// astro dev では getSessionUser が常にダミーユーザーを返すため（src/lib/user-session.ts）、
// 「未ログイン」の分岐は curl では再現できない。ここで純粋関数として直接検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	hasSupabaseAuthCookie,
	isSharedCacheablePath,
	mergeVaryHeader,
	PRIVATE_CACHE_CONTROL,
	resolveCacheDecision,
	SHARED_CACHE_CONTROL,
} from '../src/lib/cache-policy.ts';

describe('isSharedCacheablePath', () => {
	it('対象パスを許可する', () => {
		assert.equal(isSharedCacheablePath('/'), true);
		assert.equal(isSharedCacheablePath('/items'), true);
		assert.equal(isSharedCacheablePath('/tags'), true);
		assert.equal(isSharedCacheablePath('/tags/python'), true);
		assert.equal(isSharedCacheablePath('/about'), true);
		assert.equal(isSharedCacheablePath('/rss.xml'), true);
		assert.equal(isSharedCacheablePath('/sitemap.xml'), true);
	});

	it('対象外パスは拒否する', () => {
		assert.equal(isSharedCacheablePath('/mypage'), false);
		assert.equal(isSharedCacheablePath('/api/items'), false);
		assert.equal(isSharedCacheablePath('/tags-other'), false);
	});
});

describe('hasSupabaseAuthCookie', () => {
	it('sb- プレフィックスの Cookie を検出する', () => {
		assert.equal(hasSupabaseAuthCookie('sb-test-auth-token=x'), true);
		assert.equal(hasSupabaseAuthCookie('foo=bar; sb-access-token=y'), true);
	});

	it('sb- が無ければ false', () => {
		assert.equal(hasSupabaseAuthCookie(null), false);
		assert.equal(hasSupabaseAuthCookie('foo=bar; other=baz'), false);
	});
});

describe('resolveCacheDecision', () => {
	it('未ログイン・Cookie無し・対象パスの GET は共有キャッシュを許可する', () => {
		const decision = resolveCacheDecision({
			method: 'GET',
			pathname: '/items',
			isLoggedIn: false,
			cookieHeader: null,
		});
		assert.equal(decision.shared, true);
		assert.equal(decision.cacheControl, SHARED_CACHE_CONTROL);
	});

	it('ログイン中は private, no-store', () => {
		const decision = resolveCacheDecision({
			method: 'GET',
			pathname: '/items',
			isLoggedIn: true,
			cookieHeader: null,
		});
		assert.equal(decision.shared, false);
		assert.equal(decision.cacheControl, PRIVATE_CACHE_CONTROL);
	});

	it('locals.user が null でも sb- Cookie があれば private, no-store', () => {
		const decision = resolveCacheDecision({
			method: 'GET',
			pathname: '/',
			isLoggedIn: false,
			cookieHeader: 'sb-test-auth-token=x',
		});
		assert.equal(decision.shared, false);
		assert.equal(decision.cacheControl, PRIVATE_CACHE_CONTROL);
	});

	it('対象外パスは未ログインでも private, no-store', () => {
		const decision = resolveCacheDecision({
			method: 'GET',
			pathname: '/mypage',
			isLoggedIn: false,
			cookieHeader: null,
		});
		assert.equal(decision.shared, false);
		assert.equal(decision.cacheControl, PRIVATE_CACHE_CONTROL);
	});

	it('GET 以外は対象パスでも private, no-store', () => {
		const decision = resolveCacheDecision({
			method: 'POST',
			pathname: '/items',
			isLoggedIn: false,
			cookieHeader: null,
		});
		assert.equal(decision.shared, false);
		assert.equal(decision.cacheControl, PRIVATE_CACHE_CONTROL);
	});
});

describe('mergeVaryHeader', () => {
	it('Vary が無ければ Cookie のみ', () => {
		assert.equal(mergeVaryHeader(null), 'Cookie');
	});

	it('既存の Vary に Cookie を追記する', () => {
		assert.equal(mergeVaryHeader('Origin'), 'Origin, Cookie');
	});

	it('既に Cookie を含む場合は重複させない', () => {
		assert.equal(mergeVaryHeader('Cookie'), 'Cookie');
		assert.equal(mergeVaryHeader('Origin, Cookie'), 'Origin, Cookie');
	});
});
