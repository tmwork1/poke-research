// タグ名そのものを付け替える（統合ではなく単純リネーム）メンテナンススクリプト。
// 例: node --env-file=.env scripts/db/rename-tag.mjs ポケモン図鑑 図鑑
//
// to タグが既に存在する場合は同義語の統合であり本スクリプトの対象外のため、
// merge-tag.mjs を使うよう案内して終了する（tags.name の一意制約に違反するため）。
// from タグが存在しなければ何もしない（冪等）。本番 DB へ実行する前にユーザー確認を取ること。
// --dry-run を付けると変更予定の内容表示のみ行い、DB へは書き込まない。
import { createClient } from '@supabase/supabase-js';

// src/lib/importers/article-ai.ts の normalizeTagName と合わせる（tags.name はこの正規化済み表記で保存する）。
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
const [fromNameRaw, toNameRaw] = args.filter((a) => !a.startsWith('--'));
if (!fromNameRaw || !toNameRaw) {
  console.error('Usage: node scripts/db/rename-tag.mjs <from-tag> <to-tag> [--dry-run]');
  process.exit(1);
}
const fromName = normalizeTagName(fromNameRaw);
const toName = normalizeTagName(toNameRaw);
if (fromName === toName) {
  console.error('from タグと to タグが同じです。');
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
  if (toTag) {
    console.error(
      `to タグ「${toName}」は既に存在します（#${toTag.id}）。これは同義語統合のため merge-tag.mjs を使ってください:\n` +
        `  node scripts/db/merge-tag.mjs ${fromNameRaw} ${toNameRaw}`,
    );
    process.exit(2);
  }

  if (dryRun) {
    console.log(`[dry-run] タグ「${fromName}」(#${fromTag.id}) を「${toName}」へリネーム予定。DB への書き込みは行っていません。`);
    return;
  }

  const { error: updateError } = await supabase.from('tags').update({ name: toName, display_name: null }).eq('id', fromTag.id);
  if (updateError) throw updateError;

  console.log(`タグ「${fromName}」(#${fromTag.id}) を「${toName}」へリネームしました。`);
}

main().catch((e) => { console.error(e); process.exit(9); });
