// sources の一覧取得と新規作成を扱う API ルート。
// 収集元の登録・管理を外部から行うための入口になる。
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from '../_shared';
import { fetchAllSources, insertSource } from '../../../lib/db';
import type { SourceInsert } from '../../../lib/db';

export const prerender = false;

export async function GET() {
  const sources = await fetchAllSources();
  return jsonResponse({ data: sources });
}

export async function POST({ request }: { request: Request }) {
  const body = await readJsonBody<Partial<SourceInsert>>(request);
  if (body.response) return body.response;
  if (!body.data || !body.data.name) {
    return badRequest('name is required');
  }

  const source = await insertSource({
    name: body.data.name,
    type: body.data.type ?? null,
    origin_url: body.data.origin_url ?? null,
    metadata: body.data.metadata ?? {},
  });

  return jsonResponse({ data: source }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;