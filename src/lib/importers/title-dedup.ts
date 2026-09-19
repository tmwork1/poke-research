// タイトルによる重複判定の正規化。cloudflare:workers に依存しない純粋関数のため
// tests/title-dedup.test.ts で直接ユニットテストできる（arxiv-feed.ts / openalex-parse.ts と同方針）。
//
// items.normalized_title（migrations/031、生成列）と同じ結果を返す必要がある。
// 生成列は lower(regexp_replace(title, '[^[:alnum:]]+', '', 'g'))。PostgreSQL の [:alnum:] は
// UTF-8 データベースでは日本語などの文字も英数字として扱う一方、①②のような囲み数字
// （Unicode一般カテゴリ No）は英数字として扱わない。JS側で \p{N} を使うと No まで残って
// 結果がずれる（本番1188件中14件で不一致を確認）ため、10進数字のみの \p{Nd} を使う。
export function normalizeTitleForDedup(title: string | null | undefined): string {
	return (title ?? '').replace(/[^\p{L}\p{Nd}]+/gu, '').toLowerCase();
}
