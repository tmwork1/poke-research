// 管理者向け Basic 認証の検証処理。
// 単一管理者・低リスクの前提のため、タイミングセーフ比較などは行わず単純な文字列比較に留める。
import { env } from 'cloudflare:workers';

const runtimeEnv = (globalThis.process?.env ?? {}) as Record<string, string | undefined>;

function getEnvVar(name: string): string {
  return (env as Record<string, string | undefined>)[name] || runtimeEnv[name] || '';
}

export type AdminAuthResult = { ok: true; username: string } | { ok: false };

export function checkAdminAuth(request: Request): AdminAuthResult {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Basic ')) return { ok: false };

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return { ok: false };
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return { ok: false };
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  const expectedUsername = getEnvVar('ADMIN_USERNAME');
  const expectedPassword = getEnvVar('ADMIN_PASSWORD');
  if (!expectedUsername || !expectedPassword) return { ok: false };
  if (username !== expectedUsername || password !== expectedPassword) return { ok: false };

  return { ok: true, username };
}
