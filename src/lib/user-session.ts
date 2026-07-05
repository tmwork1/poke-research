// Google ログイン（Supabase Auth）向けの Cookie ベースセッション処理。
// 管理者 Basic 認証（lib/auth.ts）とは別レーンとして扱う。
import { env } from 'cloudflare:workers';
import { createServerClient } from '@supabase/ssr';
import type { AstroCookies, AstroCookieSetOptions } from 'astro';

const runtimeEnv = (globalThis.process?.env ?? {}) as Record<string, string | undefined>;

function getEnvVar(name: string): string {
  return (env as Record<string, string | undefined>)[name] || runtimeEnv[name] || '';
}

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(';')
    .map((pair) => {
      const index = pair.indexOf('=');
      if (index === -1) return { name: pair.trim(), value: '' };
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter((cookie) => cookie.name.length > 0);
}

export function createUserSupabaseClient(request: Request, cookies: AstroCookies) {
  const SUPABASE_URL = getEnvVar('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = getEnvVar('SUPABASE_PUBLISHABLE_KEY');

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get('cookie'));
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookies.set(name, value, options as AstroCookieSetOptions);
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

function toSessionUser(user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> }): SessionUser {
  const metadata = user.user_metadata ?? {};
  const displayName = (metadata.full_name as string | undefined) ?? (metadata.name as string | undefined) ?? null;
  return { id: user.id, email: user.email ?? null, displayName };
}

export async function getSessionUser(request: Request, cookies: AstroCookies): Promise<SessionUser | null> {
  const supabase = createUserSupabaseClient(request, cookies);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return toSessionUser(data.user);
}
