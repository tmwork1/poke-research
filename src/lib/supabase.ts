// Cloudflare 実行環境とローカル環境の両方で動く Supabase クライアント生成処理。
// 必要に応じて process.env を補って、開発時の実行差を吸収する。
import { env } from 'cloudflare:workers';
import { countingFetch } from './subrequest-counter';

const runtimeEnv = globalThis.process?.env ?? {};
type ProcessLike = {
	env: Record<string, string | undefined>;
  stdout?: { write: (chunk: string) => boolean };
  stderr?: { write: (chunk: string) => boolean };
};

function ensureProcessEnv() {
	const globalProcess = globalThis as typeof globalThis & { process?: ProcessLike };
	if (!globalProcess.process) {
    globalProcess.process = {
      env: {},
      stdout: { write: () => true },
      stderr: { write: () => true },
    };
    return globalProcess.process;
	}
  globalProcess.process.stdout ??= { write: () => true };
  globalProcess.process.stderr ??= { write: () => true };
	return globalProcess.process;
}

function getSupabaseConfig() {
  const SUPABASE_URL = env.SUPABASE_URL || runtimeEnv.SUPABASE_URL || '';
  const SUPABASE_PUBLISHABLE_KEY = env.SUPABASE_PUBLISHABLE_KEY || runtimeEnv.SUPABASE_PUBLISHABLE_KEY || '';
  return { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };
}

export async function getSupabaseClient() {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = getSupabaseConfig();
  ensureProcessEnv();

  const { createClient } = await import('@supabase/supabase-js');

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    // 開発中は環境変数が未設定でも手元で動かすことがあるため警告に留める
    // 実運用では例外を投げてもよい
    // eslint-disable-next-line no-console
    console.warn('Supabase env vars not set: SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY');
  }

  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    detectSessionInUrl: false,
    // countingFetch は DEBUG_SUBREQUEST_COUNT 有効時のみ計測し、それ以外は素通しする
    // （src/lib/subrequest-counter.ts）。Viteの依存事前バンドルでSupabaseクライアント内部の
    // fetch参照がglobalThis.fetchの差し替えより先に確定するため、globalな差し替えではなく
    // ここでオプションとして直接渡す必要がある。
    global: { fetch: countingFetch },
  });
}
