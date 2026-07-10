// explanation 未生成のタグ（tags.explained_at IS NULL）を一覧表示する読み取り専用スクリプト。
// Claude Code がこの出力を読み、専門用語かどうか・解説文面を判定した上で
// apply-tag-explanation.mjs で書き込む（backfill-tag-explanations.mjs の代替、OpenAI不使用）。
//
// 使い方: node --env-file=.env.production scripts/db/list-unexplained-tags.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  const { data: tags, error } = await supabase
    .from('tags')
    .select('id, name')
    .is('explained_at', null)
    .order('id');
  if (error) throw error;

  console.log(`explanation 未生成タグ: ${tags?.length ?? 0} 件`);
  for (const tag of tags ?? []) {
    console.log(`#${tag.id} ${tag.name}`);
  }
}

main().catch((e) => { console.error(e); process.exit(9); });
