// 単一 source の取得・更新・削除を扱う API ルート。
// 共通の id 検証と部分更新の組み立てをこのファイルでまとめる。
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  noContent,
  notFound,
  parseIdParam,
  readJsonBody,
} from '../_shared';
import { deleteSource, getSourceById, updateSource } from '../../../lib/db';
import type { SourceUpdate } from '../../../lib/db';

export const prerender = false;

export async function GET({ params }: { params: Record<string, string | undefined> }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const source = await getSourceById(id);
  if (!source) return notFound('source not found');
  return jsonResponse({ data: source });
}

async function updateHandler({ params, request }: { params: Record<string, string | undefined>; request: Request }) {
  const id = parseIdParam(params);
  if (!id) return badRequest('valid id is required');

  const body = await readJsonBody<Partial<SourceUpdate>>(request);
  if (body.response) return body.response;
  if (!body.data || Object.keys(body.data).length === 0) {
    return badRequest('request body is required');
  }

  const source = await updateSource(id, {
    ...(body.data.name !== undefined ? { name: body.data.name } : {}),
    ...(body.data.type !== undefined ? { type: body.data.type } : {}),
    ...(body.data.origin_url !== undefined ? { origin_url: body.data.origin_url } : {}),
    ...(body.data.metadata !== undefined ? { metadata: body.data.metadata } : {}),
  });

  if (!source) return notFound('source not found');
  return jsonResponse({ data: source });
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

  const deleted = await deleteSource(id);
  if (!deleted) return notFound('source not found');
  return noContent();
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);