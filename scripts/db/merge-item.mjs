// 重複item（クロスポスト等）を統合するメンテナンススクリプト。
// 例: node scripts/db/merge-item.mjs 34 224
//
// from item の item_tags/bookmarks を to item へ付け替え（重複は破棄）、annotations を
// 付け替えたうえで from item 本体を削除する（残る子行は ON DELETE CASCADE で削除される）。
// from item が存在しなければ何もしない（冪等）。本番 DB へ実行する前にユーザー確認を取ること。
// --dry-run を付けると付け替え対象件数と削除予定itemの表示のみ行い、DB へは書き込まない。
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [fromIdRaw, toIdRaw] = args.filter((a) => !a.startsWith('--'));
const fromId = Number(fromIdRaw);
const toId = Number(toIdRaw);
if (!fromIdRaw || !toIdRaw || !Number.isInteger(fromId) || !Number.isInteger(toId)) {
  console.error('Usage: node scripts/db/merge-item.mjs <from-id> <to-id> [--dry-run]');
  process.exit(1);
}
if (fromId === toId) {
  console.error('from-id と to-id が同じです。');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function findItem(id) {
  const { data, error } = await supabase.from('items').select('id, title').eq('id', id).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function main() {
  const fromItem = await findItem(fromId);
  if (!fromItem) {
    console.log(`from item #${fromId} は存在しません。何もしません。`);
    return;
  }
  const toItem = await findItem(toId);
  if (!toItem) {
    console.error(`to item #${toId} が存在しません。統合先を先に確認してください。`);
    process.exit(2);
  }

  const { data: fromTags, error: fromTagsError } = await supabase
    .from('item_tags')
    .select('tag_id')
    .eq('item_id', fromId);
  if (fromTagsError) throw fromTagsError;
  const { data: toTags, error: toTagsError } = await supabase
    .from('item_tags')
    .select('tag_id')
    .eq('item_id', toId);
  if (toTagsError) throw toTagsError;
  const existingTagIds = new Set((toTags ?? []).map((r) => r.tag_id));
  const tagsToInsert = (fromTags ?? [])
    .filter((r) => !existingTagIds.has(r.tag_id))
    .map((r) => ({ item_id: toId, tag_id: r.tag_id }));

  const { data: fromBookmarks, error: fromBookmarksError } = await supabase
    .from('bookmarks')
    .select('user_id')
    .eq('item_id', fromId);
  if (fromBookmarksError) throw fromBookmarksError;
  const { data: toBookmarks, error: toBookmarksError } = await supabase
    .from('bookmarks')
    .select('user_id')
    .eq('item_id', toId);
  if (toBookmarksError) throw toBookmarksError;
  const existingBookmarkUserIds = new Set((toBookmarks ?? []).map((r) => r.user_id));
  const bookmarksToInsert = (fromBookmarks ?? [])
    .filter((r) => !existingBookmarkUserIds.has(r.user_id))
    .map((r) => ({ item_id: toId, user_id: r.user_id }));

  const { data: fromAnnotations, error: fromAnnotationsError } = await supabase
    .from('annotations')
    .select('id')
    .eq('item_id', fromId);
  if (fromAnnotationsError) throw fromAnnotationsError;
  const annotationCount = (fromAnnotations ?? []).length;

  if (dryRun) {
    console.log(
      `[dry-run] item #${fromId} "${fromItem.title}" -> #${toId} "${toItem.title}" へ統合予定: ` +
        `item_tags付け替え ${tagsToInsert.length} 件、bookmarks付け替え ${bookmarksToInsert.length} 件、` +
        `annotations付け替え ${annotationCount} 件。DB への書き込みは行っていません。`,
    );
    return;
  }

  if (tagsToInsert.length > 0) {
    const { error } = await supabase.from('item_tags').insert(tagsToInsert);
    if (error) throw error;
  }

  // bookmarks は INSERT/DELETE トリガーで items.bookmarks_count を同期するため、
  // UPDATE ではなく INSERT で付け替える（トリガーを正しく発火させるため）。
  if (bookmarksToInsert.length > 0) {
    const { error } = await supabase.from('bookmarks').insert(bookmarksToInsert);
    if (error) throw error;
  }

  if (annotationCount > 0) {
    const { error } = await supabase.from('annotations').update({ item_id: toId }).eq('item_id', fromId);
    if (error) throw error;
  }

  const { error: deleteError } = await supabase.from('items').delete().eq('id', fromId);
  if (deleteError) throw deleteError;

  console.log(
    `item #${fromId} "${fromItem.title}" を #${toId} "${toItem.title}" へ統合しました` +
      `（tags付け替え ${tagsToInsert.length} 件、bookmarks付け替え ${bookmarksToInsert.length} 件、annotations付け替え ${annotationCount} 件）。`,
  );
}

main().catch((e) => { console.error(e); process.exit(9); });
