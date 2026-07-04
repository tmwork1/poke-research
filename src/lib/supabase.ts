import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // 開発中は環境変数が未設定でも手元で動かすことがあるため警告に留める
  // 実運用では例外を投げてもよい
  // eslint-disable-next-line no-console
  console.warn('Supabase env vars not set: SUPABASE_URL or SUPABASE_ANON_KEY');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  detectSessionInUrl: false,
});

export default supabase;
