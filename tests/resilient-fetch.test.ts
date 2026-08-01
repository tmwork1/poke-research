// Supabase Cloudflareエッジの一過性エラー（523/1016等）に対する参照系リトライの回帰テスト。
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { withTransientRetry } from '../src/lib/resilient-fetch.ts';

function jsonResponse(status: number): Response {
  return new Response('{}', { status });
}

describe('withTransientRetry', () => {
  it('GETが1回目で成功すればリトライしない', async () => {
    const fetchFn = mock.fn(async () => jsonResponse(200));
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com');

    assert.equal(response.status, 200);
    assert.equal(fetchFn.mock.callCount(), 1);
  });

  it('GETが523で失敗したら1回だけ再試行して成功を返す', async () => {
    let call = 0;
    const fetchFn = mock.fn(async () => {
      call += 1;
      return call === 1 ? jsonResponse(523) : jsonResponse(200);
    });
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com');

    assert.equal(response.status, 200);
    assert.equal(fetchFn.mock.callCount(), 2);
  });

  it('リトライしても失敗するなら最後のレスポンスをそのまま返す', async () => {
    const fetchFn = mock.fn(async () => jsonResponse(530));
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com');

    assert.equal(response.status, 530);
    assert.equal(fetchFn.mock.callCount(), 2);
  });

  it('fetch自体が例外を投げても1回だけ再試行する', async () => {
    let call = 0;
    const fetchFn = mock.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError('network error');
      return jsonResponse(200);
    });
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com');

    assert.equal(response.status, 200);
    assert.equal(fetchFn.mock.callCount(), 2);
  });

  it('リトライ対象外のステータス（4xx）はリトライしない', async () => {
    const fetchFn = mock.fn(async () => jsonResponse(404));
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com');

    assert.equal(response.status, 404);
    assert.equal(fetchFn.mock.callCount(), 1);
  });

  it('POSTなど書き込み系はリトライしない', async () => {
    const fetchFn = mock.fn(async () => jsonResponse(523));
    const wrapped = withTransientRetry(fetchFn as unknown as typeof fetch);

    const response = await wrapped('https://example.com', { method: 'POST' });

    assert.equal(response.status, 523);
    assert.equal(fetchFn.mock.callCount(), 1);
  });
});
