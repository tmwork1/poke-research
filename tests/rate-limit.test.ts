// メモリ内固定ウィンドウレートリミッタの回帰テスト。
// Cloudflare ダッシュボードのレートリミットルールが本命の防御であり、
// これはあくまで多層防御の1層（ベストエフォート）としての実装であることを踏まえて検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFixedWindowRateLimiter } from '../src/lib/rate-limit.ts';

describe('createFixedWindowRateLimiter', () => {
  it('上限内であれば許可し続ける', () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60_000, max: 3 });
    const now = 1_000_000;

    assert.equal(limiter.check('user-1', now).allowed, true);
    assert.equal(limiter.check('user-1', now + 10).allowed, true);
    assert.equal(limiter.check('user-1', now + 20).allowed, true);
  });

  it('上限を超えると拒否する', () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60_000, max: 3 });
    const now = 1_000_000;

    limiter.check('user-1', now);
    limiter.check('user-1', now + 10);
    limiter.check('user-1', now + 20);
    const result = limiter.check('user-1', now + 30);

    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.ok(result.retryAfterMs > 0);
  });

  it('ウィンドウが経過すると再び許可する', () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60_000, max: 1 });
    const now = 1_000_000;

    assert.equal(limiter.check('user-1', now).allowed, true);
    assert.equal(limiter.check('user-1', now + 1000).allowed, false);
    // ウィンドウ（60秒）が経過した後は新しいウィンドウとして再び許可される。
    assert.equal(limiter.check('user-1', now + 60_000).allowed, true);
  });

  it('キー（ユーザー/IP）ごとに独立してカウントする', () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60_000, max: 1 });
    const now = 1_000_000;

    assert.equal(limiter.check('user-1', now).allowed, true);
    assert.equal(limiter.check('user-2', now).allowed, true);
    assert.equal(limiter.check('user-1', now + 1).allowed, false);
    assert.equal(limiter.check('user-2', now + 1).allowed, false);
  });

  it('remaining は消費に応じて減っていく', () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60_000, max: 3 });
    const now = 1_000_000;

    assert.equal(limiter.check('user-1', now).remaining, 2);
    assert.equal(limiter.check('user-1', now + 1).remaining, 1);
    assert.equal(limiter.check('user-1', now + 2).remaining, 0);
  });
});
