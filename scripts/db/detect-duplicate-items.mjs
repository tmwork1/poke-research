// 同一記事のクロスポスト（Qiita / Zenn / 個人ブログ等）の候補を検出して一覧表示する。
// 判定結果はDBに保存しない（都度 items から再計算する使い捨てのレビュー用ツール）。
//
// 検出条件:
//   1) 正規化 URL（プロトコル・www・クエリ・末尾スラッシュを除去）が一致
//   2) 正規化タイトル（空白・記号除去・小文字化）が一致、または編集距離が長さの1割以下
//
// 使い方: node --env-file=.env scripts/db/detect-duplicate-items.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  process.exit(1);
}
const supabase = createClient(url, key, { detectSessionInUrl: false });

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

function normalizeTitle(value) {
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

function isSimilarTitle(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // 「Step1/Step2」「第8世代/第9世代」のような連載・バージョン違いを誤検出しないよう、
  // 数字列が異なる場合は完全一致以外を別記事として扱う。
  const digitsA = (a.match(/\d+/g) ?? []).join(',');
  const digitsB = (b.match(/\d+/g) ?? []).join(',');
  if (digitsA !== digitsB) return false;
  const maxLen = Math.max([...a].length, [...b].length);
  if (maxLen < 10) return false; // 短いタイトルの誤検出を避ける
  return levenshtein(a, b) <= Math.floor(maxLen * 0.1);
}

async function main() {
  const { data: items, error } = await supabase.from('items').select('id, title, external_url').order('id');
  if (error) throw error;

  const pairs = [];
  const list = (items ?? []).map((item) => ({
    ...item,
    normUrl: normalizeUrl(item.external_url),
    normTitle: normalizeTitle(item.title),
  }));

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const urlHit = a.normUrl && b.normUrl && a.normUrl === b.normUrl;
      const titleHit = isSimilarTitle(a.normTitle, b.normTitle);
      if (urlHit || titleHit) {
        pairs.push({ from: a, to: b, reason: urlHit ? 'url' : 'title' });
      }
    }
  }

  if (pairs.length === 0) {
    console.log('重複候補はありません。');
    return;
  }

  for (const pair of pairs) {
    console.log(`[${pair.reason}] #${pair.from.id} "${pair.from.title}" <-> #${pair.to.id} "${pair.to.title}"`);
  }
  console.log(`\n${pairs.length} 組の候補。`);
}

main().catch((e) => { console.error(e); process.exit(9); });
