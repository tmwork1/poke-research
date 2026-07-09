// 既存アイテムへ、収集時に使っている改善後プロンプト（src/lib/importers/article-ai.ts）を
// 再適用し、summary とタグ（item_tags）を最新の判定基準で更新し直すバックフィルスクリプト。
//
// 背景: プロンプト改善は今後の新規収集にしか効かず、既に取り込み済みのアイテムには反映
// されない。このスクリプトは Qiita/Zenn/note/ブログどのインポーターで取り込まれたかに
// 関わらず、items テーブルの行を直接読み書きする。
//
// 注意（実装上の重複について）: src/lib/importers/article-ai.ts・common.ts は
// `import { env } from 'cloudflare:workers'` に依存しており、Cloudflare Workers 実行環境
// 前提のためプレーンな Node スクリプトから import できない（他の scripts/db/*.mjs も同じ理由
// で src/lib を import せず、同等のロジックをスクリプト内に複製している）。そのため本スクリプト
// でも reviewImportArticle（応答パース）と syncItemTags（タグ差分同期）相当のロジックを
// このファイル内に複製している。ただし system prompt 自体は src/lib/importers/ai-review-prompt.mjs・
// topic.config.mjs（cloudflare:workers に依存しないプレーンJS）を直接 import して共有するため、
// トピック設定を変更してもここを個別に直す必要はない。タグ同期ロジックを変更した場合は、
// src/lib/importers/common.ts と本ファイルの両方を更新すること。
//
// 挙動:
//   - items を id 昇順で走査し、各アイテムの title/external_url/authors/本文/現在のタグを
//     reviewImportArticle 相当の呼び出しへ渡す。
//   - body 列（migrations/015）が入っている行は body を、無い（NULL・空文字）行は summary を
//     フォールバックとしてレビュー入力に使う。両方無ければそのアイテムはスキップする
//     （既存アイテムは migrations/015 適用前に取り込まれたものが多く body が無いことがある。
//     収集元 API への再取得は行わない）。
//   - language（items.language、migrations/021）は accepted の結果に関わらず常に更新する
//     （記事本文の主な言語という事実情報のため、主題の採否とは独立に記録する）。
//   - accepted が true の場合のみ summary と タグ（item_tags）を新しい判定結果で更新する。
//   - accepted が false（今の基準なら不採用。language が ja/en 以外の場合を含む）の場合は
//     summary もタグも更新せず、警告ログのみを出す。既に公開済みのアイテムを自動で
//     非公開・削除にはしない（要人手確認）。日本語・英語以外と判定された既存アイテムの削除は
//     scripts/db/delete-non-ja-en-items.mjs で別途行う。
//   - OpenAI 課金が発生するため、既定では対象を絞らず全件処理する点に注意。--id / --limit
//     で対象を絞り込める。--dry-run を付けると DB 書き込みをせず判定結果だけ表示する。
//
// 使い方:
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs --dry-run   # 全件プレビューのみ
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs --id=123    # 1件だけ実行
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs --limit=20  # 先頭20件だけ実行
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs --service=blog        # blog由来のみ対象
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs --service=blog --dry-run --limit=20
//   node --env-file=.env.production scripts/db/retag-existing-items.mjs             # 全件実行（要事前確認）
import { createClient } from '@supabase/supabase-js';
import { topic } from '../../src/config/topic.config.mjs';
import { buildSystemPrompt, computePromptHash } from '../../src/lib/importers/ai-review-prompt.mjs';

const MAX_AI_TAGS = 5; // src/lib/importers/article-ai.ts の normalizeAiTags と合わせる
const MAX_AI_BODY_CHARS = 4000; // 各インポーター（qiita/zenn/note/blog）の MAX_AI_BODY_CHARS と合わせる
const TOP_TAG_LIMIT = 40; // src/lib/importers/common.ts の fetchTopTagNames の既定値と合わせる

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const idArgRaw = args.find((a) => a.startsWith('--id='))?.split('=')[1];
const limitArgRaw = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const serviceArgRaw = args.find((a) => a.startsWith('--service='))?.split('=')[1];
const targetId = idArgRaw !== undefined ? Number(idArgRaw) : null;
const limit = limitArgRaw !== undefined ? Number(limitArgRaw) : null;
// items.metadata->>service（例: 'blog'/'qiita'/'zenn'/'note'）で対象を絞り込む。
// 未指定なら全サービスが対象（従来どおり）。
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
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-5-nano';
if (!url || !key || !apiKey) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY / OPENAI_API_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

// ---------------------------------------------------------------------------
// 以下、src/lib/importers/article-ai.ts 相当（OpenAI 呼び出し・応答パース）。
// システムプロンプトは src/lib/importers/ai-review-prompt.mjs の buildSystemPrompt を共有する。
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = buildSystemPrompt(topic);
// items.ai_recheck_prompt_hash（migrations/025）に書き込むハッシュ。SYSTEM_PROMPT と同じ
// kind='article' 前提で計算する（このスクリプト自体が kind を区別せず全アイテムを article 基準で
// 再評価する既存の制約に合わせている。paper については別途要検討、今回のタスクのスコープ外）。
const PROMPT_HASH = await computePromptHash(topic);
// このハッシュが実際どのプロンプト文面だったかを後から引けるよう記録する（migrations/026、
// docs/issue/items-schema-scalability.md）。プロンプト全文は保存せず、既にgitが持つ
// ai-review-prompt.mjs の履歴と重複させない。スクリプト全体でハッシュは1つだけなので1回のみ実行。
{
  const { error: promptHashError } = await supabase
    .from('ai_prompt_hashes')
    .upsert({ prompt_hash: PROMPT_HASH, kind: 'article' }, { onConflict: 'prompt_hash', ignoreDuplicates: true });
  if (promptHashError) throw promptHashError;
}

function normalizeTagName(tagName) {
  // 大文字小文字違い（AI/ai）やアクセント記号違い（Pokédex/pokedex）のタグが
  // 別タグとして重複しないよう、小文字・アクセント除去に統一する。
  const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');
  return tagName
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .normalize('NFC')
    .toLowerCase();
}

function buildTagLabels(rawTags) {
  const labels = {};
  for (const raw of rawTags) {
    const trimmed = raw.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const normalized = normalizeTagName(trimmed);
    if (!normalized || labels[normalized]) continue;
    labels[normalized] = trimmed;
  }
  return labels;
}

function normalizeAiTags(tags) {
  const normalized = [...new Set(tags.map(normalizeTagName).filter((tag) => tag.length > 0))].slice(0, MAX_AI_TAGS);
  const tagLabels = buildTagLabels(tags);
  for (const key of Object.keys(tagLabels)) {
    if (!normalized.includes(key)) delete tagLabels[key];
  }
  return { tags: normalized, tagLabels };
}

function createOpenAIRequest(input) {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        // インデント整形はトークンの無駄になるだけでモデルの理解には寄与しないため、コンパクトなJSONで送る。
        content: JSON.stringify({
          source_name: input.sourceName,
          query: input.query,
          title: input.title,
          url: input.url,
          authors: input.authors,
          source_tags: input.sourceTags,
          existing_tags: input.existingTags ?? [],
          created_at: input.createdAt,
          updated_at: input.updatedAt,
          body_excerpt: input.bodyExcerpt,
        }),
      },
    ],
  };
}

function parseAiResponse(content) {
  const trimmed = content.trim();
  const normalized = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  const parsed = JSON.parse(normalized);
  const accepted = typeof parsed.accepted === 'boolean' ? parsed.accepted : parsed.accept;
  if (typeof accepted !== 'boolean') throw new Error('OpenAI response missing accepted flag');

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const language = typeof parsed.language === 'string' ? parsed.language.trim().toLowerCase() : '';
  const { tags, tagLabels } = Array.isArray(parsed.tags)
    ? normalizeAiTags(parsed.tags.filter((tag) => typeof tag === 'string'))
    : { tags: [], tagLabels: {} };
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

  if (!summary) throw new Error('OpenAI response missing summary');
  if (!reason) throw new Error('OpenAI response missing reason');
  if (!language) throw new Error('OpenAI response missing language');

  return { accepted, summary, tags, tagLabels, reason, confidence, language };
}

async function reviewImportArticle(input) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createOpenAIRequest(input)),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response did not include message content');

  return { ...parseAiResponse(content), model, promptHash: PROMPT_HASH };
}

// ---------------------------------------------------------------------------
// 以下、src/lib/importers/common.ts 相当（近似タグ寄せ・タグ差分同期・上位タグ取得）。
// ---------------------------------------------------------------------------

function levenshteinDistance(a, b) {
  const s = [...a];
  const t = [...b];
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[t.length];
}

function findNearDuplicateTag(tagName, existingTags) {
  const chars = [...tagName];
  if (chars.length < 5) return null;
  if (!chars.some((ch) => ch.charCodeAt(0) > 0x7f)) return null;

  for (const existing of existingTags) {
    if (existing.name === tagName) continue;
    if (Math.abs([...existing.name].length - chars.length) > 1) continue;
    if (levenshteinDistance(tagName, existing.name) !== 1) continue;
    const hasDigit = /\d/.test(tagName) || /\d/.test(existing.name);
    if (hasDigit && tagName.replace(/\d/g, '') === existing.name.replace(/\d/g, '')) continue;
    return existing;
  }
  return null;
}

async function ensureTags(tagNames, tagLabels = {}) {
  const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
  const tagIdMap = new Map();
  if (normalizedTagNames.length === 0) return tagIdMap;

  const { data: existingTags, error: selectError } = await supabase.from('tags').select('id, name').in('name', normalizedTagNames);
  if (selectError) throw selectError;

  for (const tag of existingTags ?? []) {
    tagIdMap.set(tag.name, tag.id);
  }

  let missingTagNames = normalizedTagNames.filter((tagName) => !tagIdMap.has(tagName));
  if (missingTagNames.length > 0) {
    const { data: allTags, error: allTagsError } = await supabase.from('tags').select('id, name');
    if (allTagsError) throw allTagsError;
    missingTagNames = missingTagNames.filter((tagName) => {
      const nearDuplicate = findNearDuplicateTag(tagName, allTags ?? []);
      if (!nearDuplicate) return true;
      tagIdMap.set(tagName, nearDuplicate.id);
      return false;
    });
  }
  if (missingTagNames.length > 0) {
    const { error: insertError } = await supabase
      .from('tags')
      .insert(missingTagNames.map((name) => ({ name, display_name: tagLabels[name] && tagLabels[name] !== name ? tagLabels[name] : null })));
    if (insertError && insertError.code !== '23505') throw insertError;

    const { data: refreshedTags, error: refreshError } = await supabase.from('tags').select('id, name').in('name', normalizedTagNames);
    if (refreshError) throw refreshError;

    for (const tag of refreshedTags ?? []) {
      tagIdMap.set(tag.name, tag.id);
    }
  }

  return tagIdMap;
}

async function syncItemTags(itemId, tagNames, tagLabels = {}) {
  const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];

  const tagIdMap = await ensureTags(normalizedTagNames, tagLabels);
  const desiredTagIds = new Set(normalizedTagNames.map((tagName) => tagIdMap.get(tagName)).filter((tagId) => typeof tagId === 'number'));

  const { data: existingRelations, error: selectError } = await supabase.from('item_tags').select('tag_id').eq('item_id', itemId);
  if (selectError) throw selectError;
  const existingTagIds = new Set((existingRelations ?? []).map((relation) => relation.tag_id));

  const toInsert = [...desiredTagIds].filter((tagId) => !existingTagIds.has(tagId)).map((tagId) => ({ item_id: itemId, tag_id: tagId }));
  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from('item_tags').insert(toInsert);
    if (insertError) throw insertError;
  }

  const toDelete = [...existingTagIds].filter((tagId) => !desiredTagIds.has(tagId));
  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase.from('item_tags').delete().eq('item_id', itemId).in('tag_id', toDelete);
    if (deleteError) throw deleteError;
  }
}

async function fetchTopTagNames(topLimit = TOP_TAG_LIMIT) {
  // 集計は DB 側の RPC（migrations/012 の top_tags）で行う。
  const { data, error } = await supabase.rpc('top_tags', { tag_limit: topLimit });
  if (error) throw error;
  return (data ?? []).map((row) => row.name);
}

// ---------------------------------------------------------------------------
// ここからスクリプト本体。
// ---------------------------------------------------------------------------

function currentTagNames(itemTagsJoin) {
  // item_tags(tag:tags(name)) の結合結果は Supabase の型上、単一オブジェクトにも配列にも
  // なりうる（src/lib/catalog.ts の normalizeTags と同じ吸収処理）。
  if (!Array.isArray(itemTagsJoin)) return [];
  return itemTagsJoin.flatMap((entry) => {
    const rawTag = entry?.tag;
    if (!rawTag) return [];
    if (Array.isArray(rawTag)) return rawTag.map((tag) => tag?.name).filter(Boolean);
    return rawTag.name ? [rawTag.name] : [];
  });
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
    // AIレビューで棄却され一覧から隠れている記事（migrations/018）は再タグ付け対象外にする
    // （棄却記事のタグ付け直しは不要なため）。
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
  const items = await fetchTargetItems();
  console.log(`対象アイテム: ${items.length} 件${dryRun ? '（--dry-run: DB への書き込みは行いません）' : ''}`);
  if (items.length === 0) return;

  // AIレビューがタグを新規発明しがちな問題を減らすため、使用頻度の高い既存タグを
  // 事前に取得し existing_tags として渡す（src/lib/importers/common.ts の fetchTopTagNames と同じ用途）。
  const existingTags = await fetchTopTagNames();

  let updated = 0;
  let rejected = 0;
  let skippedNoBody = 0;
  let failed = 0;

  for (const item of items) {
    // body（migrations/015）が入っていればそれを使い、無い（NULL・空文字）行は summary に
    // フォールバックする。既存アイテムには migrations/015 適用前に取り込まれたものが多く、
    // body が NULL のままのケースがある想定。
    const bodySource = item.body && item.body.trim().length > 0 ? item.body : item.summary ?? '';
    const bodyExcerpt = bodySource.length > MAX_AI_BODY_CHARS ? bodySource.slice(0, MAX_AI_BODY_CHARS) : bodySource;
    if (!bodyExcerpt) {
      console.warn(`#${item.id} "${item.title}": body / summary のどちらも無いためスキップします。`);
      skippedNoBody += 1;
      continue;
    }

    // 収集元サイトでの元タグは保存していないため、現在割り当て済みのタグを代わりに
    // source_tags として渡す（既存の判断材料の1つとして扱う）。
    const sourceTags = currentTagNames(item.item_tags);

    try {
      const review = await reviewImportArticle({
        title: item.title ?? '',
        url: item.external_url ?? '',
        authors: item.authors ?? [],
        sourceTags,
        existingTags,
        bodyExcerpt,
        query: item.metadata?.provenance?.query ?? item.metadata?.provenance?.topic ?? '',
        createdAt: item.metadata?.provenance?.fetched_at,
        sourceName: item.metadata?.service,
      });

      // language（migrations/021）は主題の採否とは独立した事実情報のため、不採用でも
      // 既存の「公開済みアイテムは自動非公開・削除にしない」方針とは別に書き込む。
      // ai_recheck_*（migrations/025）も、ai_accepted 自体は書き換えない方針とは無関係に
      // 常に上書きする（「今の基準なら本当はどう判定されるか」をSQLで追検証できるようにする）。
      if (!dryRun) {
        const { error: languageError } = await supabase
          .from('items')
          .update({
            language: review.language,
            ai_recheck_accepted: review.accepted,
            ai_recheck_model: model,
            ai_recheck_prompt_hash: PROMPT_HASH,
            ai_recheck_reason: review.reason,
            ai_recheck_confidence: review.confidence ?? null,
            ai_rechecked_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        if (languageError) throw languageError;
      }

      if (!review.accepted) {
        // 既に公開済みのアイテムを自動で非公開・削除にはしない。判定が変わったことだけ
        // 記録し、対応は利用者の判断に委ねる。
        console.warn(`#${item.id} "${item.title}": 現行基準では不採用と判定されました（reason: ${review.reason}, language: ${review.language}, confidence: ${review.confidence}）。summary/タグの更新はスキップします。要確認。`);
        rejected += 1;
        continue;
      }

      console.log(`#${item.id} "${item.title}": summary/タグを更新${dryRun ? '予定' : ''} -> tags=[${review.tags.join(', ')}] (language: ${review.language}, confidence: ${review.confidence}, reason: ${review.reason})`);
      if (!dryRun) {
        // ai_review_*（migrations/025）は「公開中の内容を生んだ判定」なので、summaryが実際に
        // 更新されるこのタイミングでのみ ai_recheck_* と同じ値を書き込む（不採用分岐では
        // summary/タグ同様、更新しない）。
        const { error: updateError } = await supabase
          .from('items')
          .update({
            summary: review.summary,
            ai_review_model: model,
            ai_review_prompt_hash: PROMPT_HASH,
            ai_review_reason: review.reason,
            ai_review_confidence: review.confidence ?? null,
            ai_reviewed_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        if (updateError) throw updateError;
        await syncItemTags(item.id, review.tags, review.tagLabels);
      }
      updated += 1;
    } catch (e) {
      // 1件の失敗がバッチ全体を止めないよう、アイテム単位で例外を吸収する。
      console.error(`#${item.id} "${item.title}": 失敗 -`, e.message);
      failed += 1;
    }
  }

  console.log(`完了: 更新 ${updated} 件 / 不採用(要確認) ${rejected} 件 / 本文なしスキップ ${skippedNoBody} 件 / 失敗 ${failed} 件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(9);
});
