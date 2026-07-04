import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from '../_shared';
import { insertAnnotation } from '../../../lib/db';
import type { AnnotationInsert } from '../../../lib/db';
import { fetchCatalogAnnotations } from '../../../lib/catalog';

export const prerender = false;

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function GET({ request }: { request: Request }) {
  const url = new URL(request.url);
  const itemId = parseOptionalNumber(url.searchParams.get('item_id') ?? url.searchParams.get('itemId'));
  const annotations = await fetchCatalogAnnotations(itemId);
  return jsonResponse({ data: annotations, meta: { count: annotations.length } });
}

export async function POST({ request }: { request: Request }) {
  const body = await readJsonBody<Partial<AnnotationInsert>>(request);
  if (body.response) return body.response;
  if (!body.data || body.data.item_id === undefined) {
    return badRequest('item_id is required');
  }

  const annotation = await insertAnnotation({
    item_id: body.data.item_id,
    author_id: body.data.author_id ?? null,
    kind: body.data.kind ?? null,
    value: body.data.value ?? null,
    provenance: body.data.provenance ?? null,
  });

  return jsonResponse({ data: annotation }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;