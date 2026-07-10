// list-unexplained-tags.mjs で見つけたタグ1件に、Claude Code（または委譲したサブエージェント）が
// 判定した解説を書き込む（backfill-tag-explanations.mjs の代替、OpenAI不使用）。
//
// 判定基準（元 backfill-tag-explanations.mjs の system prompt を踏襲）: タグ名が
// プログラミング初心者や一般読者にとって説明なしでは理解しづらい専門用語かどうかを判定し、
// 専門用語であれば日本語で1〜2文の平易な解説を用意する。専門用語でなければ --not-difficult を使う。
//
// 使い方:
//   node scripts/db/apply-tag-explanation.mjs <tag> --explanation="..."   # 専門用語として解説を保存
//   node scripts/db/apply-tag-explanation.mjs <tag> --not-difficult       # 平易な語として記録
//   末尾に --dry-run を付けると書き込み内容の表示のみ行う。
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const notDifficult = args.includes('--not-difficult');
const explanationArg = args.find((a) => a.startsWith('--explanation='))?.slice('--explanation='.length);
const [tagNameRaw] = args.filter((a) => !a.startsWith('--'));

if (!tagNameRaw) {
  console.error('Usage: node scripts/db/apply-tag-explanation.mjs <tag> (--explanation="..." | --not-difficult) [--dry-run]');
  process.exit(1);
}
if (notDifficult && explanationArg) {
  console.error('--not-difficult と --explanation は同時に指定できません。');
  process.exit(1);
}
if (!notDifficult && !explanationArg) {
  console.error('--explanation="..." または --not-difficult のどちらかを指定してください。');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  const { data: tag, error } = await supabase.from('tags').select('id, name').eq('name', tagNameRaw).limit(1);
  if (error) throw error;
  const target = tag?.[0];
  if (!target) {
    console.log(`タグ「${tagNameRaw}」は存在しません。何もしません。`);
    return;
  }

  const isDifficult = !notDifficult;
  const explanation = isDifficult ? explanationArg.trim() : null;

  if (dryRun) {
    console.log(`[dry-run] #${target.id} ${target.name}: is_difficult=${isDifficult}, explanation=${explanation ? JSON.stringify(explanation) : 'null'}`);
    return;
  }

  const { error: updateError } = await supabase
    .from('tags')
    .update({ is_difficult: isDifficult, explanation, explained_at: new Date().toISOString() })
    .eq('id', target.id);
  if (updateError) throw updateError;

  console.log(`#${target.id} ${target.name}: ${isDifficult ? '解説を保存しました' : '平易語として記録しました'}`);
}

main().catch((e) => { console.error(e); process.exit(9); });
