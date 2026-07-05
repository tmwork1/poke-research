// Google ログイン開始。Supabase Auth の認可URLへリダイレクトする。
import type { APIContext } from 'astro';
import { createUserSupabaseClient } from '../../../lib/user-session';
import { jsonResponse, methodNotAllowed } from '../_shared';

export const prerender = false;

export async function GET({ request, cookies, redirect }: APIContext) {
  const supabase = createUserSupabaseClient(request, cookies);
  const origin = new URL(request.url).origin;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${origin}/api/auth/callback` },
  });

  if (error || !data.url) {
    return jsonResponse({ error: error?.message ?? 'Failed to start login' }, 500);
  }

  return redirect(data.url);
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
