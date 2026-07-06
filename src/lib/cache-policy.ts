// 未ログインの GET リクエストに Cloudflare エッジ / 共有キャッシュ向けの
// Cache-Control を付与するための判定ロジック。
// astro:middleware に依存しない純粋関数として切り出し、ユニットテストで検証できるようにする。

const SHARED_CACHE_EXACT_PATHS = new Set<string>([
  '/',
  '/items',
  '/tags',
  '/about',
  '/rss.xml',
  '/sitemap.xml',
]);

const SHARED_CACHE_PREFIXES = ['/tags/'];

export const SHARED_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

// 共有キャッシュの対象となりうるパスか（メソッドやログイン状態は考慮しない）。
export function isSharedCacheablePath(pathname: string): boolean {
  if (SHARED_CACHE_EXACT_PATHS.has(pathname)) return true;
  return SHARED_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Supabase Auth のセッション Cookie（sb- プレフィックス）が1つでも含まれるか。
// locals.user が null でも Cookie が残っている＝セッション検証中/失効直後の可能性があるため、
// 共有キャッシュから他人のHTMLを返さないための二重ガードとして使う。
export function hasSupabaseAuthCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(';').some((pair) => {
    const name = pair.split('=')[0]?.trim() ?? '';
    return name.startsWith('sb-');
  });
}

export interface CacheDecisionInput {
  method: string;
  pathname: string;
  isLoggedIn: boolean;
  cookieHeader: string | null;
}

export interface CacheDecision {
  // true の場合のみ共有キャッシュ用ヘッダ（public 系 + Vary: Cookie）を付与する。
  shared: boolean;
  cacheControl: string;
}

export function resolveCacheDecision({ method, pathname, isLoggedIn, cookieHeader }: CacheDecisionInput): CacheDecision {
  if (
    method === 'GET' &&
    isSharedCacheablePath(pathname) &&
    !isLoggedIn &&
    !hasSupabaseAuthCookie(cookieHeader)
  ) {
    return { shared: true, cacheControl: SHARED_CACHE_CONTROL };
  }
  return { shared: false, cacheControl: PRIVATE_CACHE_CONTROL };
}

// 既存の Vary ヘッダを保ったまま Cookie を追記する。
export function mergeVaryHeader(existing: string | null): string {
  if (!existing) return 'Cookie';
  const values = existing.split(',').map((v) => v.trim());
  if (values.some((v) => v.toLowerCase() === 'cookie')) return existing;
  return [...values, 'Cookie'].join(', ');
}
