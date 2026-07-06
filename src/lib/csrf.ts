// Cookie 認証（Supabase Auth）で動く状態変更エンドポイント向けの CSRF 対策。
// astro:middleware に依存しない純粋関数として切り出し、ユニットテストで検証できるようにする
// （src/lib/cache-policy.ts と同じ方針）。
//
// ブラウザは同一オリジン以外からのフォーム送信・fetch でも Cookie を自動送信してしまうため、
// Origin ヘッダーとリクエスト先オリジンが一致しない場合はブラウザ経由の偽装リクエストとみなして拒否する。
// curl やサーバー間連携など、Origin ヘッダー自体を送らないクライアントは対象外として許可する
// （Origin の送信可否はブラウザが強制するものであり、正規のブラウザリクエストであれば必ず送られるため）。
export function isSameOrigin(originHeader: string | null, requestUrl: string): boolean {
  if (!originHeader) return true;

  try {
    const originUrl = new URL(originHeader);
    const targetUrl = new URL(requestUrl);
    return originUrl.origin === targetUrl.origin;
  } catch {
    // Origin ヘッダーが URL として不正な形式なら、安全側に倒して拒否する。
    return false;
  }
}
