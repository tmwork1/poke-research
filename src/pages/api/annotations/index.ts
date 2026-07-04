import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from '../_shared';
import { fetchAllAnnotations, insertAnnotation } from '../../../lib/db';
import type { AnnotationInsert } from '../../../lib/db';

export const prerender = false;

export async function GET() {
  const annotations = await fetchAllAnnotations();
  return jsonResponse({ data: annotations });
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