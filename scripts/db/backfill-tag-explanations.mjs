// explanation 未生成のタグへ AI 解説をまとめてバックフィルする。
// src/lib/tag-explain.ts と同じプロンプト・キャッシュ列（is_difficult/explanation/explained_at）を使う。
// explained_at が入っているタグはスキップするため冪等。OpenAI 課金に注意して実行する。
//
// 使い方: node --env-file=.env scripts/db/backfill-tag-explanations.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-5-nano';
if (!url || !key || !apiKey) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY / OPENAI_API_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

async function explain(tagName) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'あなたはポケモンプログラミング情報ハブの用語解説アシスタントです。入力されたタグ名が、プログラミング初心者や一般読者にとって説明なしでは理解しづらい専門用語かどうかを判定してください。専門用語であれば、日本語で1〜2文の平易な解説を書いてください。専門用語でなければ explanation は null にしてください。出力はJSONオブジェクトのみで、is_difficult(boolean)とexplanation(string|null)を含めてください。',
        },
        { role: 'user', content: JSON.stringify({ tag: tagName }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response missing content');
  const parsed = JSON.parse(content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, ''));
  if (typeof parsed.is_difficult !== 'boolean') throw new Error('missing is_difficult');
  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation.trim() : null;
  return { isDifficult: parsed.is_difficult, explanation: parsed.is_difficult && explanation ? explanation : null };
}

async function main() {
  const { data: tags, error } = await supabase
    .from('tags')
    .select('id, name')
    .is('explained_at', null)
    .order('id');
  if (error) throw error;

  console.log(`explanation 未生成タグ: ${tags?.length ?? 0} 件`);
  let difficult = 0;
  for (const tag of tags ?? []) {
    try {
      const result = await explain(tag.name);
      const { error: updateError } = await supabase
        .from('tags')
        .update({
          is_difficult: result.isDifficult,
          explanation: result.explanation,
          explained_at: new Date().toISOString(),
        })
        .eq('id', tag.id);
      if (updateError) throw updateError;
      if (result.isDifficult) difficult += 1;
      console.log(`#${tag.id} ${tag.name}: ${result.isDifficult ? '解説生成' : '平易語'}`);
    } catch (e) {
      console.error(`#${tag.id} ${tag.name}: 失敗 -`, e.message);
    }
  }
  console.log(`完了: 解説生成 ${difficult} 件`);
}

main().catch((e) => { console.error(e); process.exit(9); });
