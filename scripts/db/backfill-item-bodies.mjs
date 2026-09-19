// 既存アイテムの再判定の材料を補うため、収集元から本文を取り直す。
// 更新するのは items.body だけ。ai_accepted / summary / タグ / version などは変更せず、
// AI レビューも実行しない（課金なし）。
//
// 使い方:
//   node --env-file=.env.production scripts/db/backfill-item-bodies.mjs --route=qiita-importer --dry-run
//   node --env-file=.env.production scripts/db/backfill-item-bodies.mjs --id=123
//   node --env-file=.env.production scripts/db/backfill-item-bodies.mjs --limit=20 --interval=200
// --dry-run は DB の読み取りと対象表示のみ。本文 API の取得・DB 更新は行わない。
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { topic } from '../../src/config/topic.config.mjs';

// src/lib/importers/qiita.ts / zenn.ts の MAX_AI_BODY_CHARS（ともに4000）を転記。
// インポーター側を変更した場合は、ここも合わせる。
const MAX_AI_BODY_CHARS = 4000;
const PAGE_SIZE = 500;

export function parseArgs(args) {
  const options = { route: null, id: null, limit: null, interval: 200, dryRun: false };
  const seen = new Set();
  for (const arg of args) {
    const match = /^(--dry-run|--(?:route|id|limit|interval))(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`不明な引数: ${arg}`);
    const [, name, value] = match;
    if (seen.has(name)) throw new Error(`引数が重複しています: ${name}`);
    seen.add(name);
    if (name === '--dry-run') {
      if (value !== undefined) throw new Error('--dry-run に値は指定できません。');
      options.dryRun = true;
    } else if (name === '--route') {
      if (!value?.trim()) throw new Error('--route には空でない文字列を指定してください。');
      options.route = value.trim();
    } else {
      const number = Number(value);
      const minimum = name === '--interval' ? 0 : 1;
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(number) || number < minimum
        || (name === '--interval' && number > 2147483647)) {
        throw new Error(`${name} には${minimum === 0 ? '0以上2147483647以下' : '正'}の整数を指定してください。`);
      }
      options[name.slice(2)] = number;
    }
  }
  return options;
}

export function extractArticleId(route, externalUrl) {
  const url = new URL(externalUrl);
  const host = route === 'qiita-importer' ? 'qiita.com' : route === 'zenn-importer' ? 'zenn.dev' : null;
  const pattern = route === 'qiita-importer'
    ? /^\/[^/]+\/items\/([a-zA-Z0-9_-]+)\/?$/
    : /^\/[^/]+\/articles\/([a-zA-Z0-9_-]+)\/?$/;
  const match = pattern.exec(url.pathname);
  if (!host || url.protocol !== 'https:' || url.host !== host || url.username || url.password || !match) {
    throw new Error(`記事URLの形式が不正です: ${externalUrl}`);
  }
  return match[1];
}

// zenn.ts が使う common.ts の stripHtml と同じ変換。Node でインポーター全体を
// 読み込まないよう転記しているため、共通処理の変更時はここも合わせる。
function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBody(route, articleId) {
  const qiita = route === 'qiita-importer';
  const url = qiita ? `https://qiita.com/api/v2/items/${articleId}` : `https://zenn.dev/api/articles/${articleId}`;
  const headers = { 'User-Agent': `${topic.site.slug}-${route}` };
  const token = process.env.QIITA_TOKEN?.trim();
  if (qiita && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`本文取得失敗 (HTTP ${response.status})`);
  const data = await response.json();
  // qiita.ts の extractBodyText と同じ優先順位（rendered_body → body）・stripHtml による整形。
  // インポーター側を変更した場合は、ここも合わせる。
  const rawBody = qiita ? (data?.rendered_body ?? data?.body) : data?.article?.body_html;
  if (typeof rawBody !== 'string') throw new Error('API 応答に本文がありません。');
  const body = stripHtml(rawBody);
  if (!body.trim()) throw new Error('取得した本文が空です。');
  return body.slice(0, MAX_AI_BODY_CHARS);
}

async function fetchTargets(supabase, options) {
  const targets = [];
  let lastId = null;
  // PostgREST の行数上限で取りこぼさないよう、id を使ってページングする。
  // 本文の長さは JS 側で判定し、--limit は対象行（対象外routeを含む）の件数に適用する。
  while (true) {
    let query = supabase.from('items').select('id, external_url, collection_route, body')
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    if (lastId !== null) query = query.gt('id', lastId);
    if (options.id !== null) query = query.eq('id', options.id);
    if (options.route !== null) query = query.eq('collection_route', options.route);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const item of data) {
      if (item.body !== null && Array.from(item.body).length >= 100) continue;
      targets.push(item);
      if (options.limit !== null && targets.length >= options.limit) return targets;
    }
    lastId = data.at(-1).id;
  }
  return targets;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY が必要です。');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const items = await fetchTargets(supabase, options);
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let planned = 0;
  let requested = false;
  for (const item of items) {
    const route = item.collection_route;
    // 任意サイトの HTML 抽出は Cloudflare の HTMLRewriter に依存し、Node では
    // 再現できないため、Qiita / Zenn 以外の route は明示的に対象外とする。
    if (route !== 'qiita-importer' && route !== 'zenn-importer') {
      console.log(`#${item.id} スキップ: 対象外の route (${route ?? 'NULL'})`);
      skipped += 1;
      continue;
    }
    try {
      const articleId = extractArticleId(route, item.external_url);
      if (options.dryRun) {
        console.log(`[dry-run] #${item.id} [${route}] 本文を更新予定: ${item.external_url}`);
        planned += 1;
        continue;
      }
      if (requested) await sleep(options.interval);
      requested = true;
      const body = await fetchBody(route, articleId);
      // 取得中に別処理が本文を更新していた場合は上書きしない。他の列は送信しない。
      let query = supabase.from('items').update({ body }).eq('id', item.id);
      query = item.body === null ? query.is('body', null) : query.eq('body', item.body);
      const { data, error } = await query.select('id');
      if (error) throw error;
      if (!data?.length) {
        console.log(`#${item.id} スキップ: 本文の変更または行の削除を検出`);
        skipped += 1;
        continue;
      }
      console.log(`#${item.id} 更新: ${body.length}文字`);
      updated += 1;
    } catch (error) {
      console.error(`#${item.id} [${route}] 失敗: ${error.message}`);
      failed += 1;
    }
  }
  if (options.dryRun) console.log(`[dry-run] 更新予定${planned}件（本文API取得・DB更新なし）`);
  console.log(`更新${updated}件 / 失敗${failed}件 / スキップ${skipped}件`);
  if (failed > 0) process.exitCode = 1;
}

// import 時は実行せず、DB 接続なしで引数・URL解析を単体確認できるようにする。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
