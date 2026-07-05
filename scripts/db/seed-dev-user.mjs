// astro dev がバイパスするダミーユーザー（src/lib/user-session.ts の DEV_SESSION_USER と同じ id）を
// auth.users に登録する。auth.users への INSERT で migrations/006 のトリガーが発火し、
// public.users にも自動反映されるため、ローカル開発でお気に入り機能（bookmarks の FK）まで検証できる。
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in environment. Run scripts/db/setup-env.ps1 or set env vars.');
  process.exit(1);
}

const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
const DEV_USER_EMAIL = 'dev@localhost';
const DEV_USER_NAME = 'ローカル開発ユーザー';

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{"provider":"dev","providers":["dev"]}'::jsonb, $3::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [DEV_USER_ID, DEV_USER_EMAIL, JSON.stringify({ full_name: DEV_USER_NAME })]
    );
    // auth.users への INSERT がトリガー導入前に行われた場合など、トリガーに頼らず public.users も明示的に確保する。
    await client.query(
      `INSERT INTO public.users (id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_USER_ID, DEV_USER_EMAIL, DEV_USER_NAME]
    );
    const { rows } = await client.query('SELECT id, email, display_name FROM public.users WHERE id = $1', [DEV_USER_ID]);
    console.log('Dev user ready:', rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
