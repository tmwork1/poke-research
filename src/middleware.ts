// 管理者操作を Basic 認証で保護するミドルウェア。
// /api/audit は常に保護し、それ以外の /api/** は書き込み系メソッドのみ保護する。
// 閲覧系（GET/HEAD/OPTIONS）はカタログの公開読み取りとして認証不要のまま通す。
// これとは別レーンとして、Google ログイン（Supabase Auth）のセッションを
// 全リクエストで locals.user に読み込み、/api/auth/** はこの保護の対象外、
// /api/bookmarks はユーザーセッションの存在のみを要求する。
import { defineMiddleware } from 'astro:middleware';
import { checkAdminAuth } from './lib/auth';
import { getSessionUser } from './lib/user-session';

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
  return !READ_METHODS.has(method);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url, cookies } = context;

  context.locals.user = await getSessionUser(request, cookies).catch(() => null);

  if (isAuthRoute(url.pathname)) {
    return next();
  }

  if (requiresUserAuth(url.pathname)) {
    if (!context.locals.user) {
      return new Response(JSON.stringify({ error: 'Login required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return next();
  }

  if (!requiresAdminAuth(url.pathname, request.method)) {
    return next();
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
  return next();
});
