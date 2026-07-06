// 収集クエリ・検索・フィルタ・タグの4観点（+任意でBrave/ブログ収集）に加えて
// 重複items検出を、1コマンドでまとめて実行する。判定・修正自体はこれまで通り
// Claude Codeが各セクションの出力を読んで行う（このスクリプトは呼び出しをまとめるだけ）。
//
// 使い方:
//   npm run eval:all              # collection(qiita/zenn/note/はてなブックマーク) / filter / tags / search / 重複items検出
//   npm run eval:all -- --with-blog   # 上記に加えて Brave収集(ブログ)も評価する
//
// 注意: --with-blog は Brave Search の無料枠（月1000件≒1日30件）を消費するため既定では実行しない。
// eval:search はサーバー（astro dev --background）が必要。未起動なら自動で起動し、
// このスクリプトが起動した場合に限り終了時に停止する（元から起動済みのサーバーは触らない）。
import { execFileSync } from 'child_process';

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env not found; fall through to each sub-script's own check.
  }
}

const withBlog = process.argv.includes('--with-blog');
const baseUrl = process.env.EVAL_BASE_URL || 'http://localhost:4321';
const results = [];

function run(label, scriptPath) {
  console.log(`\n${'='.repeat(70)}\n[${label}]\n${'='.repeat(70)}`);
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: 'inherit' });
    results.push({ label, mark: 'OK' });
  } catch (error) {
    console.error(`\n[${label}] 失敗: ${error.message}`);
    results.push({ label, mark: 'FAILED' });
  }
}

async function isReachable(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitForReady(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureServer() {
  if (await isReachable(baseUrl)) {
    console.log(`\n開発サーバーは起動済みです（${baseUrl}）。`);
    return { startedByUs: false };
  }
  console.log(`\n開発サーバーが未起動のため astro dev --background で起動します（${baseUrl}）...`);
  execFileSync('npx', ['astro', 'dev', '--background'], { stdio: 'inherit' });
  const ready = await waitForReady(baseUrl);
  if (!ready) {
    console.error('起動確認がタイムアウトしました。eval:search の結果を確認し、必要なら手動で astro dev status を確認してください。');
  }
  return { startedByUs: true };
}

async function main() {
  run('収集クエリ精度 (Qiita/Zenn/note)', './scripts/eval/eval-collection.mjs');
  run('収集クエリ精度 (はてなブックマーク)', './scripts/eval/eval-collection-hatena.mjs');

  if (withBlog) {
    if (process.env.BRAVE_API_KEY) {
      console.log('\n注意: Brave Search の無料枠（月1000件）を消費します。');
      run('収集クエリ精度 (ブログ/Brave)', './scripts/eval/eval-collection-blog.mjs');
    } else {
      console.log('\n[収集クエリ精度 (ブログ/Brave)] BRAVE_API_KEY 未設定のためスキップします。');
      results.push({ label: '収集クエリ精度 (ブログ/Brave)', mark: 'SKIPPED' });
    }
  }

  run('フィルタ精度 (AI取り込みレビュー)', './scripts/eval/eval-filter.mjs');
  run('タグ精度', './scripts/eval/eval-tags.mjs');

  const { startedByUs } = await ensureServer();
  run('検索精度', './scripts/eval/eval-search.mjs');
  if (startedByUs) {
    console.log('\nこのスクリプトが起動した開発サーバーを停止します。');
    execFileSync('npx', ['astro', 'dev', 'stop'], { stdio: 'inherit' });
  }

  run('重複items検出', './scripts/db/detect-duplicate-items.mjs');

  console.log(`\n${'='.repeat(70)}\n=== まとめ ===`);
  for (const r of results) {
    console.log(`- ${r.label}: ${r.mark}`);
  }
  console.log('\n各セクションの出力を読んで、問題があれば該当箇所を修正し、個別スクリプト（npm run eval:xxx や node scripts/db/detect-duplicate-items.mjs）で再実行してください。');

  if (results.some((r) => r.mark === 'FAILED')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
