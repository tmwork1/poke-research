// 誤字タグを正しいタグへ統合するメンテナンススクリプト。
// 例: node --env-file=.env scripts/db/merge-tag.mjs ポケモンカート ポケモンカード
//
// from タグの item_tags を to タグへ付け替え（重複は削除）、from タグ本体を削除する。
// from タグが存在しなければ何もしない（冪等）。本番 DB へ実行する前にユーザー確認を取ること。
import { createClient } from '@supabase/supabase-js';

const [fromName, toName] = process.argv.slice(2);
if (!fromName || !toName) {
  console.error('Usage: node scripts/db/merge-tag.mjs <from-tag> <to-tag>');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function findTag(name) {
  const { data, error } = await supabase.from('tags').select('id, name').eq('name', name).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function main() {
  const fromTag = await findTag(fromName);
  if (!fromTag) {
    console.log(`from タグ「${fromName}」は存在しません。何もしません。`);
    return;
  }
  const toTag = await findTag(toName);
  if (!toTag) {
    console.error(`to タグ「${toName}」が存在しません。統合先を先に確認してください。`);
    process.exit(2);
  }

  const { data: fromRelations, error: relError } = await supabase
    .from('item_tags')
    .select('item_id')
    .eq('tag_id', fromTag.id);
  if (relError) throw relError;

  const { data: toRelations, error: toRelError } = await supabase
    .from('item_tags')
    .select('item_id')
    .eq('tag_id', toTag.id);
  if (toRelError) throw toRelError;
  const alreadyTagged = new Set((toRelations ?? []).map((r) => r.item_id));

  const toInsert = (fromRelations ?? [])
    .filter((r) => !alreadyTagged.has(r.item_id))
    .map((r) => ({ item_id: r.item_id, tag_id: toTag.id }));
  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from('item_tags').insert(toInsert);
    if (insertError) throw insertError;
  }

  const { error: deleteRelError } = await supabase.from('item_tags').delete().eq('tag_id', fromTag.id);
  if (deleteRelError) throw deleteRelError;

  const { error: deleteTagError } = await supabase.from('tags').delete().eq('id', fromTag.id);
  if (deleteTagError) throw deleteTagError;

  console.log(
    `タグ「${fromName}」(#${fromTag.id}) を「${toName}」(#${toTag.id}) へ統合しました（付け替え ${toInsert.length} 件、重複破棄 ${(fromRelations ?? []).length - toInsert.length} 件）。`,
  );
}

main().catch((e) => { console.error(e); process.exit(9); });
