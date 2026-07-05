// ログインユーザー自身のお気に入り（ブックマーク）の追加・削除。
// 一覧表示（item 情報付き）は catalog.ts 側の fetchBookmarkedItems* を使う。
import { getSupabaseClient } from './supabase';

export async function addBookmark(userId: string, itemId: number): Promise<void> {
  const supabase = await getSupabaseClient();
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

export async function removeBookmark(userId: string, itemId: number): Promise<void> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from('bookmarks').delete().eq('user_id', userId).eq('item_id', itemId);
  if (error) throw error;
}
