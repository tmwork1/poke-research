// 週次DBレビュー（Discord通知）の重複候補のうち、「統合しない（別記事・別ソース）」と判断した組を
// duplicate_review_dismissals（migrations/030）に登録し、以後の通知から除外する。
// 登録しないと同じ組が毎週再掲され、毎週同じ判断をやり直すことになる。
//
// 使い方:
//   node --env-file=.env.production scripts/db/dismiss-duplicate.mjs item 3 1460 --note="別著者の別記事"
//   node --env-file=.env.production scripts/db/dismiss-duplicate.mjs item 3 1460 --undismiss   # 除外を解除
//   node --env-file=.env.production scripts/db/dismiss-duplicate.mjs --list                    # 登録済み一覧
//   --dry-run を付けると書き込み内容の表示だけ行い、DBへは書き込まない。
//
// id は昇順（from_id < to_id）に正規化して保存するため、引数の順序はどちらでもよい。
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const undismiss = args.includes('--undismiss');
const listOnly = args.includes('--list');
const noteArg = args.find((a) => a.startsWith('--note='));
const note = noteArg ? noteArg.slice('--note='.length) : null;
const positional = args.filter((a) => !a.startsWith('--'));

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function listDismissals() {
  const { data, error } = await supabase
    .from('duplicate_review_dismissals')
    .select('target_kind, from_id, to_id, note, created_at')
    .order('target_kind')
    .order('from_id');
  if (error) throw error;
  if (!data?.length) {
    console.log('登録済みの除外はありません。');
    return;
  }
  for (const row of data) {
    const suffix = row.note ? ` — ${row.note}` : '';
    console.log(`[${row.target_kind}] #${row.from_id} <-> #${row.to_id} (${row.created_at?.slice(0, 10)})${suffix}`);
  }
  console.log(`\n${data.length} 件。`);
}

async function main() {
  if (listOnly) {
    await listDismissals();
    return;
  }

  const [targetKind, idARaw, idBRaw] = positional;
  const idA = Number(idARaw);
  const idB = Number(idBRaw);
  if (targetKind !== 'item' && targetKind !== 'source') {
    console.error('Usage: node scripts/db/dismiss-duplicate.mjs <item|source> <id1> <id2> [--note="理由"] [--undismiss] [--dry-run]');
    console.error('       node scripts/db/dismiss-duplicate.mjs --list');
    process.exit(1);
  }
  if (!Number.isInteger(idA) || !Number.isInteger(idB) || idA === idB) {
    console.error('id は異なる2つの整数を指定してください。');
    process.exit(1);
  }
  const fromId = Math.min(idA, idB);
  const toId = Math.max(idA, idB);

  if (undismiss) {
    if (dryRun) {
      console.log(`[dry-run] 除外を解除: [${targetKind}] #${fromId} <-> #${toId}`);
      return;
    }
    const { error } = await supabase
      .from('duplicate_review_dismissals')
      .delete()
      .eq('target_kind', targetKind)
      .eq('from_id', fromId)
      .eq('to_id', toId);
    if (error) throw error;
    console.log(`除外を解除しました: [${targetKind}] #${fromId} <-> #${toId}`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] 除外を登録: [${targetKind}] #${fromId} <-> #${toId}${note ? ` — ${note}` : ''}`);
    return;
  }
  // upsert（ON CONFLICT DO UPDATE）は UPDATE 権限を要するが、このテーブルには付与していない
  // （migrations/030）。同じ組を note を変えて登録し直せるよう、削除してから挿入する。
  const { error: deleteError } = await supabase
    .from('duplicate_review_dismissals')
    .delete()
    .eq('target_kind', targetKind)
    .eq('from_id', fromId)
    .eq('to_id', toId);
  if (deleteError) throw deleteError;
  const { error } = await supabase
    .from('duplicate_review_dismissals')
    .insert({ target_kind: targetKind, from_id: fromId, to_id: toId, note });
  if (error) throw error;
  console.log(`除外を登録しました: [${targetKind}] #${fromId} <-> #${toId}${note ? ` — ${note}` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(9); });
