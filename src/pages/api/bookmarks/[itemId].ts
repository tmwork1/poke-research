// ログインユーザー自身のブックマーク削除を扱う API ルート。
import type { APIContext } from 'astro';
import { badRequest, methodNotAllowed, noContent } from '../_shared';
import { removeBookmark } from '../../../lib/bookmarks';

export const prerender = false;

export async function DELETE({ params, locals }: APIContext) {
  const itemId = Number(params.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return badRequest('valid itemId is required');
  }
  await removeBookmark(locals.user!.id, itemId);
  return noContent();
}

export const GET = () => methodNotAllowed(['DELETE']);
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
