import { execSync } from 'child_process';

// Cloudflare Workers が GitHub の main ブランチと連携済みのため、
// アプリのビルド・デプロイ自体は push（merge を含む）で自動実行される。
// このスクリプトが担うのは、Cloudflare の自動デプロイでは行われない
// 本番 Supabase へのマイグレーション適用のみ。

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env not found; fall through to the check below.
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Add it to .env or export it before running release.');
  process.exit(1);
}

run('npm run migrate');

console.log('\nMigrations applied. Push/merge to main to trigger the Cloudflare auto-deploy. See docs/reference/operations.md for post-deploy checks.');
