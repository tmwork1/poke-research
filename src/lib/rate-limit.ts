// 書き込みAPI向けのベストエフォートなメモリ内レートリミッタ（固定ウィンドウ方式）。
//
// Cloudflare Workers は Isolate ごとにメモリが独立しており、かつ Isolate は
// リクエストのたびに再利用されるとは限らないため、これは分散排他ではなく
// 「たまたま同じ Isolate にリクエストが集中した場合に軽く効く」程度のベストエフォートに過ぎない。
// 本命の防御は Cloudflare ダッシュボード側のレートリミットルール（WAF / Rate Limiting Rules）であり、
// ここでの実装はあくまで多層防御（defense in depth）の1層として位置づける。
//
// astro:middleware に依存しない純粋な実装として切り出し、ユニットテストで検証できるようにする
// （src/lib/cache-policy.ts と同じ方針）。

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface WindowState {
  count: number;
  windowStart: number;
}

export interface FixedWindowRateLimiter {
  check(key: string, now?: number): RateLimitResult;
}

// key（ユーザーIDまたはIP）ごとに windowMs 間隔の固定ウィンドウで max 回まで許可する。
export function createFixedWindowRateLimiter(options: RateLimitOptions): FixedWindowRateLimiter {
  const store = new Map<string, WindowState>();

  function check(key: string, now: number = Date.now()): RateLimitResult {
    const existing = store.get(key);

    if (!existing || now - existing.windowStart >= options.windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: options.max - 1, retryAfterMs: 0 };
    }

    if (existing.count >= options.max) {
      return { allowed: false, remaining: 0, retryAfterMs: options.windowMs - (now - existing.windowStart) };
    }

    existing.count += 1;
    return { allowed: true, remaining: options.max - existing.count, retryAfterMs: 0 };
  }

  return { check };
}

// /api/bookmarks の書き込み（POST/DELETE）に適用する既定設定・共有インスタンス。
// ユーザーID（未ログイン時はIP）ごとに60秒で30回まで。
export const BOOKMARKS_WRITE_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 30 };
export const bookmarksWriteRateLimiter = createFixedWindowRateLimiter(BOOKMARKS_WRITE_RATE_LIMIT);

// GET /api/tags/:id/explain（未認証・OpenAI呼び出しを伴う）に適用する既定設定・共有インスタンス。
// IPごとに60秒で20回まで。
export const TAG_EXPLAIN_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 20 };
export const tagExplainRateLimiter = createFixedWindowRateLimiter(TAG_EXPLAIN_RATE_LIMIT);
