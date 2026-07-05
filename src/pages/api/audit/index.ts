// audit_logs の一覧取得を扱う API ルート。
// 管理者操作の追跡用途のため、常にミドルウェアの Basic 認証で保護される（src/middleware.ts 参照）。
import { jsonResponse, methodNotAllowed } from '../_shared';
import { fetchAuditLogs } from '../../../lib/audit';
import { parseOptionalPositiveInteger } from '../../../lib/params';

export const prerender = false;

export async function GET({ request }: { request: Request }) {
  const url = new URL(request.url);
  const logs = await fetchAuditLogs({
    table: url.searchParams.get('table') ?? undefined,
    recordId: parseOptionalPositiveInteger(url.searchParams.get('recordId')),
    limit: parseOptionalPositiveInteger(url.searchParams.get('limit')),
  });

  return jsonResponse({ data: logs, meta: { count: logs.length } });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
