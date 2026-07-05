// 管理者操作を Basic 認証で保護するミドルウェア。
// /api/audit は常に保護し、それ以外の /api/** は書き込み系メソッドのみ保護する。
// 閲覧系（GET/HEAD/OPTIONS）はカタログの公開読み取りとして認証不要のまま通す。
import { defineMiddleware } from 'astro:middleware';
import { checkAdminAuth } from './lib/auth';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requiresAuth(pathname: string, method: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/api/audit')) return true;
  return !READ_METHODS.has(method);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;

  if (!requiresAuth(url.pathname, request.method)) {
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
