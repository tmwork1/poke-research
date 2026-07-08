// items.language（migrations/021）が日本語・英語のいずれでもないと判定された記事を削除する
// メンテナンススクリプト。language は retag-existing-items.mjs のバックフィルで埋める前提のため、
// このスクリプト自体は OpenAI を呼ばず、既に判定済みの language 列を読むだけ（課金なし）。
// language が NULL（未判定）の行は対象外にする。
//
// item_tags/bookmarks は ON DELETE CASCADE（migrations/001, 007）で自動的に削除される。
// annotations も ON DELETE CASCADE（migrations/001）で削除される。
//
// 使い方:
//   node --env-file=.env.production scripts/db/delete-non-ja-en-items.mjs --dry-run   # 削除予定を一覧表示するだけ
//   node --env-file=.env.production scripts/db/delete-non-ja-en-items.mjs             # 実際に削除する（要事前確認）
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  const { data, error } = await supabase
    .from('items')
    .select('id, title, external_url, language')
    .not('language', 'is', null)
    .not('language', 'in', '(ja,en)')
    .order('id', { ascending: true });
  if (error) throw error;

  const targets = data ?? [];
  if (targets.length === 0) {
    console.log('削除対象（日本語・英語以外と判定された記事）はありません。');
    return;
  }

  for (const item of targets) {
    console.log(`#${item.id} [${item.language}] "${item.title}" ${item.external_url}`);
  }

  if (dryRun) {
    console.log(`[dry-run] 上記 ${targets.length} 件を削除予定です。DB への書き込みは行っていません。`);
    return;
  }

  const { error: deleteError } = await supabase
    .from('items')
    .delete()
    .in('id', targets.map((item) => item.id));
  if (deleteError) throw deleteError;

  console.log(`${targets.length} 件を削除しました。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(9);
});
