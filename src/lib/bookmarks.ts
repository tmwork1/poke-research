// ログインユーザー自身のお気に入り（ブックマーク）の追加・削除。
// 一覧表示（item 情報付き）は catalog.ts 側の fetchBookmarkedItems* を使う。
// bookmarks は RLS で auth.uid() = user_id に制限されている（migrations/027）ため、
// 匿名キーではなくユーザーのセッションを積んだクライアント（createUserSupabaseClient）を使う。
// ローカル開発の DEV_SESSION_USER（実ログインなしのダミーユーザー、user-session.ts 参照）には
// 実セッションが無く auth.uid() が解決できないため、開発時のみ RLS をバイパスする
// adminクライアントにフォールバックする。
import type { AstroCookies } from 'astro';
import { getSupabaseAdminClient } from './supabase';
import { createUserSupabaseClient } from './user-session';

async function getBookmarksClient(request: Request, cookies: AstroCookies) {
  if (import.meta.env.DEV) return getSupabaseAdminClient();
  return createUserSupabaseClient(request, cookies);
}

export async function addBookmark(request: Request, cookies: AstroCookies, userId: string, itemId: number): Promise<void> {
  const supabase = await getBookmarksClient(request, cookies);
  const { error } = await supabase
    .from('bookmarks')
    .upsert({ user_id: userId, item_id: itemId }, { onConflict: 'user_id,item_id', ignoreDuplicates: true });
  if (error) {
    if ((error as { code?: string }).code === '23503') {
      throw new Error('item not found');
    }
    throw error;
  }
}

export async function removeBookmark(request: Request, cookies: AstroCookies, userId: string, itemId: number): Promise<void> {
  const supabase = await getBookmarksClient(request, cookies);
  const { error } = await supabase.from('bookmarks').delete().eq('user_id', userId).eq('item_id', itemId);
  if (error) throw error;
}
