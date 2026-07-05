// ログインユーザー自身のブックマークの一覧取得・追加を扱う API ルート。
// locals.user の存在はミドルウェア（src/middleware.ts）側で保証済み。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { fetchBookmarkedItems } from '../../../lib/catalog';
import { addBookmark } from '../../../lib/bookmarks';

export const prerender = false;

export async function GET({ locals }: APIContext) {
  const items = await fetchBookmarkedItems(locals.user!.id);
  return jsonResponse({ data: items, meta: { count: items.length } });
}

export async function POST({ request, locals }: APIContext) {
  const body = await readJsonBody<{ itemId?: number }>(request);
  if (body.response) return body.response;
  const itemId = body.data?.itemId;
  if (!Number.isInteger(itemId) || (itemId as number) <= 0) {
    return badRequest('itemId is required');
  }

  try {
    await addBookmark(locals.user!.id, itemId as number);
  } catch (error) {
    if (error instanceof Error && error.message === 'item not found') {
      return badRequest('item not found');
    }
    throw error;
  }

  return jsonResponse({ data: { itemId } }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
