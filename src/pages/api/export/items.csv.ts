// items の一覧を CSV で出力する API ルート。
// フィルタ条件は /api/items と同じ q/kind/tag/sourceId を受け付け、公開データの閲覧と同等に認証不要とする。
import { methodNotAllowed } from '../_shared';
import { fetchCatalogItems } from '../../../lib/catalog';
import { parseOptionalPositiveInteger } from '../../../lib/params';
import { buildCsv } from '../../../lib/csv';

export const prerender = false;

const HEADERS = [
  'id',
  'title',
  'kind',
  'source_name',
  'source_type',
  'external_url',
  'published_at',
  'tags',
  'summary',
  'version',
  'created_at',
];

export async function GET({ request }: { request: Request }) {
  const url = new URL(request.url);
  const items = await fetchCatalogItems({
    q: url.searchParams.get('q') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    sourceId: parseOptionalPositiveInteger(url.searchParams.get('sourceId')),
  });

  const rows = items.map((item) => [
    String(item.id),
    item.title ?? '',
    item.kind ?? '',
    item.source?.name ?? '',
    item.source?.type ?? '',
    item.external_url ?? '',
    item.published_at ?? '',
    item.tags.map((tag) => tag.name).join(';'),
    item.summary ?? '',
    item.version ?? '',
    item.created_at ?? '',
  ]);

  const csv = buildCsv(HEADERS, rows);
  // Excel(Windows) が UTF-8 を正しく解釈できるよう BOM (U+FEFF) を先頭に付ける。
  return new Response('﻿' + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="items.csv"',
    },
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
