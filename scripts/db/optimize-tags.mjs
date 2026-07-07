// タグ最適化（大/小文字・冗長接頭辞の短縮化、不適切タグの削除候補の洗い出し）を
// 定期的に見直すためのメンテナンススクリプト。
//
// eval/eval-tags.mjs（使用件数・サンプル記事タイトルの生データ出力、OpenAI不使用）とは別に、
// 本スクリプトはタグ一覧全体を1回のOpenAI呼び出しに渡し、リネーム/統合/削除の提案と、
// 提案をそのまま適用できる rename-tag.mjs / merge-tag.mjs / delete-tag.mjs のコマンド例を出力する。
//
// 重要: 本スクリプトは DB を一切書き換えない（読み取り専用、提案の印字のみ）。
// 提案は必ず人間（Claude Code 経由の場合は会話でユーザー）が内容を確認し、
// 妥当なものだけ該当コマンドを個別に実行すること。OpenAI の提案を無条件に信用しない。
//
// 使い方: node --env-file=.env.production scripts/db/optimize-tags.mjs
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

const SYSTEM_PROMPT =
  'あなたは技術記事キュレーションサイト（ポケモンのプログラミング・開発情報だけを扱うハブ）のタグ台帳を整理する担当です。' +
  '入力にはタグ名・使用件数・サンプル記事タイトルを含むタグ一覧全体が渡されます。次の観点で問題があるタグだけを提案してください（問題が無いタグは出力に含めないでください）。' +
  '(1) 大文字小文字や略語表記が公式表記と異なる（例: openai-codexのような不要な接頭辞や、本来大文字にすべき略語が小文字のままなど）。' +
  '(2) サイト全体がポケモン関連の技術記事だけを扱う前提なのに「ポケモン」を冗長に含む・説明的すぎて長いタグ（例: ポケモン対戦分析→対戦分析）。' +
  '(3) 具体的な技術要素やポケモン側の対象を指さない一般語・その記事にしか使えない無意味なタグで、検索の絞り込みに使えないもの。' +
  '(4) 同義・表記ゆれで別々のタグとして存在しているもの（統合候補）。' +
  '出力はJSON配列のみで、各要素は {tag, action, target, reason} を持ってください。actionは "rename"（単純リネーム、target必須）・"merge"（同義語を既存の別タグへ統合、target必須で必ずtag一覧に実在する別名にすること）・"delete"（削除、targetは不要）のいずれかです。' +
  '確信が持てない・使用件数が多く影響が大きいわりに根拠が弱い提案はしないでください。';

async function fetchTagCatalog() {
  const { data: tags, error: tagsError } = await supabase.from('tags').select('id, name');
  if (tagsError) throw tagsError;

  const { data: usageRows, error: usageError } = await supabase.rpc('top_tags', { tag_limit: 100000 });
  if (usageError) throw usageError;
  const usageByName = new Map((usageRows ?? []).map((row) => [row.name, row.count]));

  const catalog = [];
  for (const tag of tags ?? []) {
    const { data: rels, error: relError } = await supabase.from('item_tags').select('item_id').eq('tag_id', tag.id).limit(3);
    if (relError) throw relError;
    const itemIds = (rels ?? []).map((r) => r.item_id);
    let sampleTitles = [];
    if (itemIds.length > 0) {
      const { data: items, error: itemsError } = await supabase.from('items').select('title').in('id', itemIds);
      if (itemsError) throw itemsError;
      sampleTitles = (items ?? []).map((i) => i.title);
    }
    catalog.push({ name: tag.name, count: usageByName.get(tag.name) ?? 0, sample_titles: sampleTitles });
  }
  return catalog.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function requestSuggestions(catalog) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ tags: catalog }, null, 2) },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response did not include message content');

  const trimmed = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const parsed = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.suggestions) ? parsed.suggestions : Array.isArray(parsed.tags) ? parsed.tags : [];
  return list;
}

function printSuggestion(suggestion) {
  const { tag, action, target, reason } = suggestion;
  console.log(`\n[${tag}] action=${action}${target ? ` target=${target}` : ''}`);
  if (reason) console.log(`  理由: ${reason}`);
  if (action === 'rename') {
    console.log(`  node scripts/db/rename-tag.mjs ${JSON.stringify(tag)} ${JSON.stringify(target)} --dry-run`);
  } else if (action === 'merge') {
    console.log(`  node scripts/db/merge-tag.mjs ${JSON.stringify(tag)} ${JSON.stringify(target)}  # merge-tag.mjs は --dry-run 未対応。実行すると即反映される`);
  } else if (action === 'delete') {
    console.log(`  node scripts/db/delete-tag.mjs ${JSON.stringify(tag)} --dry-run`);
  }
}

async function main() {
  console.log('タグ台帳を取得しています…');
  const catalog = await fetchTagCatalog();
  console.log(`${catalog.length} 件のタグをOpenAIへ送信します（モデル: ${model}）。`);

  const suggestions = await requestSuggestions(catalog);
  if (suggestions.length === 0) {
    console.log('\n提案はありませんでした。');
    return;
  }

  console.log(`\n=== 提案 ${suggestions.length} 件（そのまま適用せず、必ず内容を確認してからコマンドを実行すること） ===`);
  for (const suggestion of suggestions) printSuggestion(suggestion);
}

main().catch((e) => {
  console.error(e);
  process.exit(9);
});
