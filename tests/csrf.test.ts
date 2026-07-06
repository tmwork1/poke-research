// Origin検証によるCSRF対策ロジックの回帰テスト。
// astro dev では getSessionUser が常にダミーユーザーを返すため、
// 未ログイン時の分岐と同様に、ここでは純粋関数として直接検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSameOrigin } from '../src/lib/csrf.ts';

describe('isSameOrigin', () => {
  it('Origin ヘッダーが無ければ許可する（curl・サーバー間連携）', () => {
    assert.equal(isSameOrigin(null, 'https://poke-research.com/api/bookmarks'), true);
  });

  it('Origin がリクエスト先と一致すれば許可する', () => {
    assert.equal(isSameOrigin('https://poke-research.com', 'https://poke-research.com/api/bookmarks'), true);
  });

  it('ポートまで含めて一致すれば許可する（ローカル開発）', () => {
    assert.equal(isSameOrigin('http://localhost:4321', 'http://localhost:4321/api/bookmarks'), true);
  });

  it('Origin がリクエスト先と異なれば拒否する', () => {
    assert.equal(isSameOrigin('https://evil.example', 'https://poke-research.com/api/bookmarks'), false);
  });

  it('スキームだけが異なる場合も拒否する', () => {
    assert.equal(isSameOrigin('http://poke-research.com', 'https://poke-research.com/api/bookmarks'), false);
  });

  it('ポートだけが異なる場合も拒否する', () => {
    assert.equal(isSameOrigin('http://localhost:3000', 'http://localhost:4321/api/bookmarks'), false);
  });

  it('Origin ヘッダーが不正な形式なら拒否する', () => {
    assert.equal(isSameOrigin('not-a-valid-origin', 'https://poke-research.com/api/bookmarks'), false);
  });
});
