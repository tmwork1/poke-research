// ローカル検証専用の開発ツール: fetch呼び出し回数を数える。
// Cloudflare Workers の subrequest は「Worker 内から発行した fetch 呼び出しの回数」と
// 一致するため、この計測値はそのまま実際の subrequest 消費数として扱える。
// middleware.ts から DEBUG_SUBREQUEST_COUNT 環境変数が設定されている場合のみ有効化され、
// 通常運用時（未設定）は一切動作しない。並行リクエストが同一カウンタを共有すると数値が
// 混ざるため、計測は1リクエストずつ順番に行うこと（scripts/eval/eval-subrequests.mjs 参照）。
//
// 注意（Viteの依存事前バンドルについて）: astro dev（Vite）は @supabase/supabase-js 等の
// npm依存を起動時に事前バンドルし、その内部で fetch を早い段階でキャプチャする。そのため
// globalThis.fetch を後からmiddleware内で差し替えるだけでは、Supabase経由の呼び出しを
// 計測できない（実測して判明。OpenAI・Qiita/Zenn/arXiv等への直接fetch呼び出しは、
// アプリ側コードが呼び出し時点で globalThis.fetch を参照するため正しく計測できる）。
// これを避けるため、supabase.ts の createClient には global.fetch オプションとして
// countingFetch を直接渡す（globalThis.fetch の差し替えに依存しない）。
let count = 0;
let active = false;
const originalFetch: typeof fetch = globalThis.fetch;

export function countingFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
	if (active) count++;
	return originalFetch(...args);
}

export function installSubrequestCounter(): void {
	active = true;
	globalThis.fetch = countingFetch as typeof fetch;
}

export function resetSubrequestCount(): void {
	count = 0;
}

export function getSubrequestCount(): number {
	return count;
}
