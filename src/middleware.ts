// 管理者操作を Basic 認証で保護するミドルウェア。
// /api/audit と /api/import/runs は常に保護し、それ以外の /api/** は書き込み系メソッドのみ保護する。
// 閲覧系（GET/HEAD/OPTIONS）はカタログの公開読み取りとして認証不要のまま通す。
// これとは別レーンとして、Google ログイン（Supabase Auth）のセッションを
// 全リクエストで locals.user に読み込み、/api/auth/** はこの保護の対象外、
// /api/bookmarks はユーザーセッションの存在に加え、書き込み系メソッドには
// CSRF対策（Origin検証）とベストエフォートのレートリミットを適用する。
// さらに、未ログインの GET ページには Cloudflare エッジ/共有キャッシュ向けの
// Cache-Control を付与し、Supabase 読み負荷と TTFB を下げる（/api/** は対象外）。
//
// ページ/API のレンダリング中に投げられた未処理例外は、Cloudflare Workers Logs
// （受動的な console.error 収集）任せにせず、収集ジョブの失敗と同じ Webhook
// （sendOperationalAlert）で能動的に通知する。
import { defineMiddleware } from 'astro:middleware';
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { checkAdminAuth } from './lib/auth';
import { getSessionUser } from './lib/user-session';
import { mergeVaryHeader, resolveCacheDecision } from './lib/cache-policy';
import { isSameOrigin } from './lib/csrf';
import { bookmarksWriteRateLimiter } from './lib/rate-limit';
import { sendOperationalAlert } from './lib/notify';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith('/api/auth/');
}

function requiresUserAuth(pathname: string): boolean {
  return pathname.startsWith('/api/bookmarks');
}

function requiresAdminAuth(pathname: string, method: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (isAuthRoute(pathname) || requiresUserAuth(pathname)) return false;
  if (pathname.startsWith('/api/audit')) return true;
  if (pathname.startsWith('/api/import/runs')) return true;
  return !READ_METHODS.has(method);
}

function jsonError(message: string, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// /api/** は触らない。それ以外のページは、未ログイン（locals.user が null かつ
// sb- プレフィックスの Supabase Auth Cookie を一切持たない）GET リクエストのみ
// 共有キャッシュ用ヘッダを付与し、それ以外は private, no-store を明示する。
function applyCacheControl(response: Response, context: APIContext): Response {
  const { request, url, locals } = context;
  if (url.pathname.startsWith('/api/')) return response;

  const decision = resolveCacheDecision({
    method: request.method,
    pathname: url.pathname,
    isLoggedIn: Boolean(locals.user),
    cookieHeader: request.headers.get('cookie'),
  });

  response.headers.set('Cache-Control', decision.cacheControl);
  if (decision.shared) {
    response.headers.set('Vary', mergeVaryHeader(response.headers.get('Vary')));
  }
  return response;
}

// リクエストハンドリング中の未処理例外を、ユーザーIDやメールなどのPIIを含めずに記録し、
// 収集ジョブと同じ運用アラート Webhook へ通知する。通知自体の失敗は
// sendOperationalAlert 側で握りつぶされるため、ここでの呼び出しは安全に fire-and-forget できる。
async function reportRequestError(pathname: string, method: string, loggedIn: boolean, error: unknown): Promise<void> {
  console.error('[middleware] unhandled request error', { pathname, method, loggedIn }, error);
  await sendOperationalAlert(env, `ページ/APIエラー: ${pathname}`, error);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url, cookies } = context;

  context.locals.user = await getSessionUser(request, cookies).catch(() => null);

  try {
    if (isAuthRoute(url.pathname)) {
      return await next();
    }

    if (requiresUserAuth(url.pathname)) {
      const isWrite = !READ_METHODS.has(request.method);

      // CSRF対策: Origin ヘッダーがあり、かつリクエスト先と一致しない場合は
      // ブラウザ経由の偽装リクエストとして拒否する（認証状態のチェックより先に行う）。
      // Origin ヘッダー自体が無いリクエスト（curl・サーバー間連携等）は許容する。
      if (isWrite && !isSameOrigin(request.headers.get('origin'), url.toString())) {
        return jsonError('Origin not allowed', 403);
      }

      if (!context.locals.user) {
        return jsonError('Login required', 401);
      }

      // ベストエフォートのメモリ内レートリミット（多層防御の1層、詳細は src/lib/rate-limit.ts）。
      // Cloudflare ダッシュボードのレートリミットルールが本命であり、これはその補完に留まる。
      if (isWrite) {
        const key = context.locals.user.id;
        const result = bookmarksWriteRateLimiter.check(key);
        if (!result.allowed) {
          return jsonError('Too many requests', 429, {
            'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)),
          });
        }
      }

      return await next();
    }

    if (!requiresAdminAuth(url.pathname, request.method)) {
      const response = await next();
      return applyCacheControl(response, context);
    }

    const result = checkAdminAuth(request);
    if (!result.ok) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Basic realm="admin"',
        },
      });
    }

    context.locals.actor = result.username;
    return await next();
  } catch (error) {
    await reportRequestError(url.pathname, request.method, Boolean(context.locals.user), error);

    // API はエンドポイントの契約に合わせて JSON の 500 を返す。
    // ページはここで握りつぶさず再送出し、Astro/Cloudflare 既定のエラーページ表示を維持する
    // （ユーザー向けの見た目は変えず、観測性だけを追加するのが目的）。
    if (url.pathname.startsWith('/api/')) {
      return jsonError('Internal Server Error', 500);
    }

    throw error;
  }
});
