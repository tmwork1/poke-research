// retag-existing-items.mjs の代替（読み取り専用の前半部分）。
// 既存アイテム（ai_accepted=true）の判定材料一式を、従来OpenAIのuser messageへ渡していたのと
// 同じ形でJSON出力する。Claude Code（またはサブエージェント）がこれを読み、
// src/lib/importers/ai-review-prompt.mjs の buildSystemPrompt() が定める基準（STEP1〜5）に
// 沿って判定した上で、結果を apply-item-review.mjs で書き込む。
//
// 使い方:
//   node --env-file=.env.production scripts/db/list-retag-targets.mjs                      # 全件
//   node --env-file=.env.production scripts/db/list-retag-targets.mjs --id=123             # 1件だけ
//   node --env-file=.env.production scripts/db/list-retag-targets.mjs --limit=20            # 先頭20件（バッチ分散用）
//   node --env-file=.env.production scripts/db/list-retag-targets.mjs --service=blog --limit=20
import { createClient } from '@supabase/supabase-js';

const MAX_AI_BODY_CHARS = 4000; // 各インポーターの MAX_AI_BODY_CHARS と合わせる
const TOP_TAG_LIMIT = 40; // src/lib/importers/common.ts の fetchTopTagNames の既定値と合わせる

const args = process.argv.slice(2);
const idArgRaw = args.find((a) => a.startsWith('--id='))?.split('=')[1];
const limitArgRaw = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const serviceArgRaw = args.find((a) => a.startsWith('--service='))?.split('=')[1];
const targetId = idArgRaw !== undefined ? Number(idArgRaw) : null;
const limit = limitArgRaw !== undefined ? Number(limitArgRaw) : null;
const targetService = serviceArgRaw?.trim() || null;
if (idArgRaw !== undefined && !Number.isInteger(targetId)) {
  console.error('--id には整数を指定してください。');
  process.exit(1);
}
if (limitArgRaw !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('--limit には正の整数を指定してください。');
  process.exit(1);
}
if (serviceArgRaw !== undefined && !targetService) {
  console.error('--service には空でない文字列を指定してください。');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

function currentTagNames(itemTagsJoin) {
  // item_tags(tag:tags(name)) の結合結果は単一オブジェクトにも配列にもなりうる
  // （src/lib/catalog.ts の normalizeTags と同じ吸収処理）。
  if (!Array.isArray(itemTagsJoin)) return [];
  return itemTagsJoin.flatMap((entry) => {
    const rawTag = entry?.tag;
    if (!rawTag) return [];
    if (Array.isArray(rawTag)) return rawTag.map((tag) => tag?.name).filter(Boolean);
    return rawTag.name ? [rawTag.name] : [];
  });
}

async function fetchTopTagNames(topLimit = TOP_TAG_LIMIT) {
  const { data, error } = await supabase.rpc('top_tags', { tag_limit: topLimit });
  if (error) throw error;
  return (data ?? []).map((row) => row.name);
}

async function fetchTargetItems() {
  let query = supabase
    .from('items')
    .select(
      `
			id,
			title,
			external_url,
			authors,
			summary,
			body,
			metadata,
			item_tags ( tag:tags ( name ) )
		`,
    )
    // 棄却済み記事（migrations/018）は対象外（従来の retag-existing-items.mjs と同じ制約）。
    .eq('ai_accepted', true)
    .order('id', { ascending: true });
  if (targetId !== null) query = query.eq('id', targetId);
  if (targetService !== null) query = query.eq('metadata->>service', targetService);
  if (limit !== null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function main() {
  const [items, existingTags] = await Promise.all([fetchTargetItems(), fetchTopTagNames()]);

  const payloadItems = [];
  let skippedNoBody = 0;
  for (const item of items) {
    const bodySource = item.body && item.body.trim().length > 0 ? item.body : item.summary ?? '';
    const bodyExcerpt = bodySource.length > MAX_AI_BODY_CHARS ? bodySource.slice(0, MAX_AI_BODY_CHARS) : bodySource;
    if (!bodyExcerpt) {
      skippedNoBody += 1;
      continue;
    }
    payloadItems.push({
      id: item.id,
      title: item.title ?? '',
      url: item.external_url ?? '',
      authors: item.authors ?? [],
      sourceTags: currentTagNames(item.item_tags),
      bodyExcerpt,
      query: item.metadata?.provenance?.query ?? item.metadata?.provenance?.topic ?? '',
      createdAt: item.metadata?.provenance?.fetched_at ?? null,
      sourceName: item.metadata?.service ?? null,
    });
  }

  console.error(`対象アイテム: ${payloadItems.length} 件（本文なしスキップ ${skippedNoBody} 件）`);
  console.log(JSON.stringify({ existingTags, items: payloadItems }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(9); });
