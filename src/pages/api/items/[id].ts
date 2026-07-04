// 単一 item の取得・更新・削除を扱う API ルート。
// 詳細表示では catalog の正規化結果を返し、更新系は DB の item だけを操作する。
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  noContent,
  notFound,
  parseIdParam,
  readJsonBody,
} from '../_shared';
import { deleteItem, getItemById, updateItem } from '../../../lib/db';
import type { ItemUpdate } from '../../../lib/db';
import { fetchCatalogItemById } from '../../../lib/catalog';

export const prerender = false;

export async function GET({ params }: { params: Record<string, string | undefined> }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const item = await fetchCatalogItemById(id);
  if (!item) return notFound('item not found');
  return jsonResponse({ data: item });
}

async function updateHandler({ params, request }: { params: Record<string, string | undefined>; request: Request }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const body = await readJsonBody<Partial<ItemUpdate>>(request);
  if (body.response) return body.response;
  if (!body.data || Object.keys(body.data).length === 0) {
    return badRequest('request body is required');
  }

  const item = await updateItem(id, {
    ...(body.data.source_id !== undefined ? { source_id: body.data.source_id } : {}),
    ...(body.data.external_url !== undefined ? { external_url: body.data.external_url } : {}),
    ...(body.data.kind !== undefined ? { kind: body.data.kind } : {}),
    ...(body.data.title !== undefined ? { title: body.data.title } : {}),
    ...(body.data.authors !== undefined ? { authors: body.data.authors } : {}),
    ...(body.data.summary !== undefined ? { summary: body.data.summary } : {}),
    ...(body.data.published_at !== undefined ? { published_at: body.data.published_at } : {}),
    ...(body.data.updated_at !== undefined ? { updated_at: body.data.updated_at } : {}),
    ...(body.data.metadata !== undefined ? { metadata: body.data.metadata } : {}),
    ...(body.data.version !== undefined ? { version: body.data.version } : {}),
  });

  if (!item) return notFound('item not found');
  return jsonResponse({ data: item });
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

  const deleted = await deleteItem(id);
  if (!deleted) return notFound('item not found');
  return noContent();
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);