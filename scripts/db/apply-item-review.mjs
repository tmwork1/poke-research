// list-retag-targets.mjs で取得した1アイテムについて、Claude Code（またはサブエージェント）が
// src/lib/importers/ai-review-prompt.mjs の buildSystemPrompt() の基準（STEP1〜5）に沿って
// 判定した結果を書き込む（retag-existing-items.mjs の後半・書き込み部分の代替、OpenAI不使用）。
//
// 挙動は元の retag-existing-items.mjs と同じ:
//   - language / ai_recheck_*（migrations/025）は accepted に関わらず常に更新する。
//   - accepted=true の場合のみ summary / ai_review_*（migrations/025）/ タグ（item_tags）を更新する。
//   - accepted=false の場合は summary もタグも更新しない（公開済みアイテムを自動で
//     非公開・削除にはしない。要人手確認）。
//   - ai_review_prompt_hash / ai_recheck_prompt_hash には引き続き
//     src/lib/importers/ai-review-prompt.mjs の computePromptHash(topic) を書き込み、
//     判定者（OpenAI/Claude Code）に関わらずどの採否基準バージョンで判定したかを追跡できるようにする。
//
// 使い方:
//   node --env-file=.env.production scripts/db/apply-item-review.mjs \
//     --id=123 --accepted=true --language=ja --reason="STEP3: 主題該当" --confidence=0.9 \
//     --summary="..." --tags="タグA,タグB" [--model=claude-code] [--dry-run]
//   node --env-file=.env.production scripts/db/apply-item-review.mjs \
//     --id=123 --accepted=false --language=en --reason="STEP4: 体験談" [--dry-run]
import { createClient } from '@supabase/supabase-js';
import { topic } from '../../src/config/topic.config.mjs';
import { computePromptHash } from '../../src/lib/importers/ai-review-prompt.mjs';

const MAX_AI_TAGS = 5; // src/lib/importers/article-ai.ts の normalizeAiTags と合わせる

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const dryRun = Boolean(flags['dry-run']);
const id = Number(flags.id);
if (!Number.isInteger(id)) {
  console.error('--id には整数を指定してください。');
  process.exit(1);
}
if (flags.accepted !== 'true' && flags.accepted !== 'false') {
  console.error('--accepted には true か false を指定してください。');
  process.exit(1);
}
const accepted = flags.accepted === 'true';
const language = typeof flags.language === 'string' ? flags.language.trim().toLowerCase() : '';
const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
if (!language) {
  console.error('--language は必須です。');
  process.exit(1);
}
if (!reason) {
  console.error('--reason は必須です。');
  process.exit(1);
}
const confidence = flags.confidence !== undefined ? Number(flags.confidence) : null;
if (flags.confidence !== undefined && (Number.isNaN(confidence) || confidence < 0 || confidence > 1)) {
  console.error('--confidence には 0〜1 の数値を指定してください。');
  process.exit(1);
}
const model = typeof flags.model === 'string' ? flags.model : 'claude-code';
const summary = typeof flags.summary === 'string' ? flags.summary.trim() : '';
const tagsRaw = typeof flags.tags === 'string' ? flags.tags : '';
if (accepted && !summary) {
  console.error('--accepted=true の場合は --summary が必須です。');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

const PROMPT_HASH = await computePromptHash(topic);

// ---------------------------------------------------------------------------
// 以下、src/lib/importers/common.ts 相当（近似タグ寄せ・タグ差分同期）。
// retag-existing-items.mjs と同じ理由（cloudflare:workers 依存のため src/lib を import できない）
// で複製している。タグ同期ロジックを変更した場合は common.ts と本ファイルの両方を更新すること。
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

async function main() {
  const { tags, tagLabels } = accepted && tagsRaw
    ? normalizeAiTags(tagsRaw.split(',').map((t) => t.trim()).filter(Boolean))
    : { tags: [], tagLabels: {} };

  if (dryRun) {
    console.log(
      `[dry-run] #${id}: language=${language}, ai_recheck_accepted=${accepted}, model=${model}, reason=${reason}, confidence=${confidence}` +
        (accepted ? `\n  summary=${JSON.stringify(summary)}\n  tags=[${tags.join(', ')}]` : '\n  （不採用のため summary/タグは更新しません）'),
    );
    return;
  }

  const { error: recheckError } = await supabase
    .from('items')
    .update({
      language,
      ai_recheck_accepted: accepted,
      ai_recheck_model: model,
      ai_recheck_prompt_hash: PROMPT_HASH,
      ai_recheck_reason: reason,
      ai_recheck_confidence: confidence,
      ai_rechecked_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (recheckError) throw recheckError;

  if (!accepted) {
    console.log(`#${id}: 不採用と判定されたため language/ai_recheck_* のみ更新しました（reason: ${reason}）。summary/タグの更新はスキップします。`);
    return;
  }

  const { error: reviewError } = await supabase
    .from('items')
    .update({
      summary,
      ai_review_model: model,
      ai_review_prompt_hash: PROMPT_HASH,
      ai_review_reason: reason,
      ai_review_confidence: confidence,
      ai_reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (reviewError) throw reviewError;

  await syncItemTags(id, tags, tagLabels);

  console.log(`#${id}: summary/タグを更新しました -> tags=[${tags.join(', ')}] (language: ${language}, confidence: ${confidence}, reason: ${reason})`);
}

main().catch((e) => { console.error(e); process.exit(9); });
