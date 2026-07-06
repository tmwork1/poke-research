// 検索・絞り込みに役立たない不適切・低情報価値なタグを削除するメンテナンススクリプト。
// 例: node --env-file=.env scripts/db/delete-tag.mjs テスト
//
// tag の item_tags を削除してから tag 本体を削除する（付け替え先が無い点が merge-tag.mjs と異なる）。
// タグが存在しなければ何もしない（冪等）。本番 DB へ実行する前にユーザー確認を取ること。
// --dry-run を付けると削除予定件数の表示のみ行い、DB へは書き込まない。
import { createClient } from '@supabase/supabase-js';

function normalizeTagName(tagName) {
  const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');
  return tagName
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .normalize('NFC')
    .toLowerCase();
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [nameRaw] = args.filter((a) => !a.startsWith('--'));
if (!nameRaw) {
  console.error('Usage: node scripts/db/delete-tag.mjs <tag> [--dry-run]');
  process.exit(1);
}
const name = normalizeTagName(nameRaw);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  const { data: tagRows, error: tagError } = await supabase.from('tags').select('id, name').eq('name', name).limit(1);
  if (tagError) throw tagError;
  const tag = tagRows?.[0];
  if (!tag) {
    console.log(`タグ「${name}」は存在しません。何もしません。`);
    return;
  }

  const { data: relations, error: relError } = await supabase.from('item_tags').select('item_id').eq('tag_id', tag.id);
  if (relError) throw relError;
  const usageCount = (relations ?? []).length;

  if (dryRun) {
    console.log(`[dry-run] タグ「${name}」(#${tag.id}) を削除予定（item_tags ${usageCount} 件も削除）。DB への書き込みは行っていません。`);
    return;
  }

  const { error: deleteRelError } = await supabase.from('item_tags').delete().eq('tag_id', tag.id);
  if (deleteRelError) throw deleteRelError;

  const { error: deleteTagError } = await supabase.from('tags').delete().eq('id', tag.id);
  if (deleteTagError) throw deleteTagError;

  console.log(`タグ「${name}」(#${tag.id}) を削除しました（item_tags ${usageCount} 件も削除）。`);
}

main().catch((e) => { console.error(e); process.exit(9); });
