// Supabase（*.supabase.co、前段にCloudflareを持つ）との通信では、Cloudflareのエッジ〜オリジン間の
// 一時的な接続エラー（523 Origin Is Unreachable、1016/530 Origin DNS Error等）やSupabase側の
// 汎用500が、数時間〜数日おきに発生する（docs/progress 参照）。参照系（GET/HEAD）は冪等なため、
// これらの一過性エラーに限り1回だけ再試行し、ユーザーへの500表示とDiscordアラートのノイズを減らす。
// 書き込み系（POST/PATCH/DELETE）は冪等性を保証できないため対象外（そのまま即座に返す/投げる）。
const RETRYABLE_STATUS_MIN = 500;
const RETRYABLE_STATUS_MAX = 530; // Cloudflareのオリジン接続エラー(521〜527, 530)を含む範囲
const RETRY_DELAY_MS = 300;

function isRetryableStatus(status: number): boolean {
  return status >= RETRYABLE_STATUS_MIN && status <= RETRYABLE_STATUS_MAX;
}

function isSafeToRetryMethod(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 与えられたfetch実装を、参照系リクエスト限定で1回リトライするfetchでラップする。
// countingFetch（開発時のsubrequest計測）等、他のfetchラッパーと重ねて使うことを想定し、
// 実際のfetch呼び出しは渡されたfetchFn経由でのみ行う。
export function withTransientRetry(fetchFn: typeof fetch): typeof fetch {
  return async function resilientFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const init = args[1];
    if (!isSafeToRetryMethod(init)) {
      return fetchFn(...args);
    }

    try {
      const response = await fetchFn(...args);
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      await delay(RETRY_DELAY_MS);
      return await fetchFn(...args);
    } catch (error) {
      // fetch自体が例外を投げるネットワーク層の失敗も、同じ一過性エラーとして1回だけ再試行する。
      await delay(RETRY_DELAY_MS);
      return await fetchFn(...args);
    }
  } as typeof fetch;
}
