// 重複 source を統合するメンテナンススクリプト。
// 例: node --env-file=.env scripts/db/merge-source.mjs 12 3
//
// from source に紐づく items.source_id を to source へ付け替え、from source 本体を削除する。
// from source が存在しなければ何もしない（冪等）。本番 DB へ実行する前にユーザー確認を取ること。
// --dry-run を付けると付け替え対象件数と削除予定 source を表示するだけで、DB へは書き込まない。
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [fromIdRaw, toIdRaw] = args.filter((a) => !a.startsWith('--'));
const fromId = Number(fromIdRaw);
const toId = Number(toIdRaw);
if (!fromIdRaw || !toIdRaw || !Number.isInteger(fromId) || !Number.isInteger(toId)) {
  console.error('Usage: node scripts/db/merge-source.mjs <from-id> <to-id> [--dry-run]');
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

async function findSource(id) {
  const { data, error } = await supabase.from('sources').select('id, name').eq('id', id).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function main() {
  const fromSource = await findSource(fromId);
  if (!fromSource) {
    console.log(`from source #${fromId} は存在しません。何もしません。`);
    return;
  }
  const toSource = await findSource(toId);
  if (!toSource) {
    console.error(`to source #${toId} が存在しません。統合先を先に確認してください。`);
    process.exit(2);
  }

  const { data: fromItems, error: itemsError } = await supabase.from('items').select('id').eq('source_id', fromId);
  if (itemsError) throw itemsError;
  const targetItemCount = (fromItems ?? []).length;

  if (dryRun) {
    console.log(
      `[dry-run] source「${fromSource.name}」(#${fromId}) -> 「${toSource.name}」(#${toId}) へ統合予定: items ${targetItemCount} 件の source_id を付け替え、source #${fromId} を削除予定。DB への書き込みは行っていません。`,
    );
    return;
  }

  if (targetItemCount > 0) {
    const { error: updateError } = await supabase.from('items').update({ source_id: toId }).eq('source_id', fromId);
    if (updateError) throw updateError;
  }

  const { error: deleteError } = await supabase.from('sources').delete().eq('id', fromId);
  if (deleteError) throw deleteError;

  console.log(
    `source「${fromSource.name}」(#${fromId}) を「${toSource.name}」(#${toId}) へ統合しました（items付け替え ${targetItemCount} 件）。`,
  );
}

main().catch((e) => { console.error(e); process.exit(9); });
