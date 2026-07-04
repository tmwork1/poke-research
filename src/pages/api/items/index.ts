import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from '../_shared';
import { fetchAllItems, insertItem } from '../../../lib/db';
import type { ItemInsert } from '../../../lib/db';

export const prerender = false;

export async function GET() {
  const items = await fetchAllItems();
  return jsonResponse({ data: items });
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