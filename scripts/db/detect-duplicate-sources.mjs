// sources の重複候補（同じブログ・著者が別 source 行になっているケース）を検出して一覧表示する。
// 判定結果はDBに保存しない（都度 sources から再計算する使い捨てのレビュー用ツール）。
//
// 検出条件（detect-duplicate-items.mjs の正規化・類似度ロジックを流用）:
//   1) 正規化 origin_url（プロトコル・www・クエリ・末尾スラッシュを除去）が一致
//   2) 正規化 name（空白・記号除去・小文字化）が一致、または編集距離が長さの1割以下
//
// 使い方: node --env-file=.env.production scripts/db/detect-duplicate-sources.mjs [--include-dismissed]
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

const includeDismissed = process.argv.slice(2).includes('--include-dismissed');

function normalizeUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/$/, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeName(value) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[!-/:-@[-`{-~「」【】（）()。、・！？]/g, '');
}

function levenshtein(a, b) {
  const s = [...a];
  const t = [...b];
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

function isSimilarName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max([...a].length, [...b].length);
  if (maxLen < 4) return false; // 短い名前の誤検出を避ける
  return levenshtein(a, b) <= Math.floor(maxLen * 0.1);
}

// 「重複ではない」と人手で判断済みの組（duplicate_review_dismissals、migrations/030）を読み、
// 出力から除外する。除外しないと毎回同じ組を目視し直すことになる
// （登録は scripts/db/dismiss-duplicate.mjs、--include-dismissed で除外せず全件表示できる）。
async function fetchDismissedKeys(targetKind) {
  const { data, error } = await supabase
    .from('duplicate_review_dismissals')
    .select('from_id, to_id')
    .eq('target_kind', targetKind);
  if (error) throw error;
  return new Set((data ?? []).map((row) => `${row.from_id}:${row.to_id}`));
}

function dismissalKey(idA, idB) {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

async function main() {
  // PostgREST の既定上限1000件で途切れないよう、ページングして全行を取得する。
  const pageSize = 1000;
  const sources = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('sources').select('id, name, origin_url').order('id').range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    sources.push(...page);
    if (page.length < pageSize) break;
  }

  const pairs = [];
  const list = (sources ?? []).map((source) => ({
    ...source,
    normUrl: normalizeUrl(source.origin_url),
    normName: normalizeName(source.name),
  }));

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const urlHit = a.normUrl && b.normUrl && a.normUrl === b.normUrl;
      const nameHit = isSimilarName(a.normName, b.normName);
      if (urlHit || nameHit) {
        pairs.push({ from: a, to: b, reason: urlHit ? 'url' : 'name' });
      }
    }
  }

  const dismissed = includeDismissed ? new Set() : await fetchDismissedKeys('source');
  const visiblePairs = pairs.filter((pair) => !dismissed.has(dismissalKey(pair.from.id, pair.to.id)));
  const dismissedCount = pairs.length - visiblePairs.length;
  const dismissedNote = dismissedCount > 0 ? `（除外済み ${dismissedCount} 組を除く）` : '';

  if (visiblePairs.length === 0) {
    console.log(`重複候補はありません。${dismissedNote}`);
    return;
  }

  for (const pair of visiblePairs) {
    console.log(
      `[${pair.reason}] #${pair.from.id} "${pair.from.name}" (${pair.from.origin_url ?? '-'}) <-> #${pair.to.id} "${pair.to.name}" (${pair.to.origin_url ?? '-'})`,
    );
  }
  console.log(`\n${visiblePairs.length} 組の候補。統合する場合は scripts/db/merge-source.mjs <from-id> <to-id> を使う。${dismissedNote}`);
}

main().catch((e) => { console.error(e); process.exit(9); });
