// Google ログインのコールバック。認可コードをセッションに交換し Cookie へ保存する。
import type { APIContext } from 'astro';
import { createUserSupabaseClient } from '../../../lib/user-session';
import { jsonResponse, methodNotAllowed } from '../_shared';

export const prerender = false;

export async function GET({ request, cookies, redirect }: APIContext) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return jsonResponse({ error: 'Missing authorization code' }, 400);
  }

  const supabase = createUserSupabaseClient(request, cookies);
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  // migrations/006 の on_auth_user_created トリガーは auth.users への INSERT 時にしか発火せず、
  // トリガー導入前に作成された auth.users 行は public.users に同期されないままになる
  // （同期漏れがあると bookmarks.user_id の FK 制約違反でお気に入り機能が失敗する）。
  // トリガーに加えてログイン成功のたびにも upsert し、既存ユーザーの同期漏れを自己修復する。
  const user = data.user;
  if (user) {
    const metadata = user.user_metadata ?? {};
    const displayName = (metadata.full_name as string | undefined) ?? (metadata.name as string | undefined) ?? user.email ?? null;
    const { error: syncError } = await supabase
      .from('users')
      .upsert({ id: user.id, email: user.email, display_name: displayName }, { onConflict: 'id', ignoreDuplicates: true });
    if (syncError) {
      console.error('[auth/callback] failed to sync public.users', { userId: user.id }, syncError);
    }
  }

  return redirect('/mypage');
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
