// items の一覧取得と新規作成を扱う API ルート。
// 検索条件は catalog 経由、登録は DB 直結で処理する。
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from '../_shared';
import { insertItem } from '../../../lib/db';
import type { ItemInsert } from '../../../lib/db';
import { fetchCatalogItems } from '../../../lib/catalog';

export const prerender = false;

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function GET({ request }: { request: Request }) {
  const url = new URL(request.url);
  const items = await fetchCatalogItems({
    q: url.searchParams.get('q') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    sourceId: parseOptionalNumber(url.searchParams.get('sourceId')),
    limit: parseOptionalNumber(url.searchParams.get('limit')),
  });

  return jsonResponse({
    data: items,
    meta: {
      count: items.length,
      filters: {
        q: url.searchParams.get('q') ?? '',
        kind: url.searchParams.get('kind') ?? '',
        tag: url.searchParams.get('tag') ?? '',
        sourceId: url.searchParams.get('sourceId') ?? '',
        limit: url.searchParams.get('limit') ?? '',
      },
    },
  });
}

export async function POST({ request }: { request: Request }) {
  const body = await readJsonBody<Partial<ItemInsert>>(request);
  if (body.response) return body.response;
  if (!body.data) {
    return badRequest('request body is required');
  }

  const item = await insertItem({
    source_id: body.data.source_id ?? null,
    external_url: body.data.external_url ?? null,
    kind: body.data.kind ?? null,
    title: body.data.title ?? null,
    authors: body.data.authors ?? null,
    summary: body.data.summary ?? null,
    published_at: body.data.published_at ?? null,
    updated_at: body.data.updated_at ?? null,
    metadata: body.data.metadata ?? {},
    version: body.data.version ?? null,
  });

  return jsonResponse({ data: item }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;