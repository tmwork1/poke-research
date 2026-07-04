import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  noContent,
  notFound,
  parseIdParam,
  readJsonBody,
} from '../_shared';
import { deleteAnnotation, getAnnotationById, updateAnnotation } from '../../../lib/db';
import type { AnnotationUpdate } from '../../../lib/db';

export const prerender = false;

export async function GET({ params }: { params: Record<string, string | undefined> }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const annotation = await getAnnotationById(id);
  if (!annotation) return notFound('annotation not found');
  return jsonResponse({ data: annotation });
}

async function updateHandler({ params, request }: { params: Record<string, string | undefined>; request: Request }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const body = await readJsonBody<Partial<AnnotationUpdate>>(request);
  if (body.response) return body.response;
  if (!body.data || Object.keys(body.data).length === 0) {
    return badRequest('request body is required');
  }

  const annotation = await updateAnnotation(id, {
    ...(body.data.item_id !== undefined ? { item_id: body.data.item_id } : {}),
    ...(body.data.author_id !== undefined ? { author_id: body.data.author_id } : {}),
    ...(body.data.kind !== undefined ? { kind: body.data.kind } : {}),
    ...(body.data.value !== undefined ? { value: body.data.value } : {}),
    ...(body.data.provenance !== undefined ? { provenance: body.data.provenance } : {}),
  });

  if (!annotation) return notFound('annotation not found');
  return jsonResponse({ data: annotation });
}

export async function PUT(args: { params: Record<string, string | undefined>; request: Request }) {
  return updateHandler(args);
}

export async function PATCH(args: { params: Record<string, string | undefined>; request: Request }) {
  return updateHandler(args);
}

export async function DELETE({ params }: { params: Record<string, string | undefined> }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const deleted = await deleteAnnotation(id);
  if (!deleted) return notFound('annotation not found');
  return noContent();
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);