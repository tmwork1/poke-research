// ブログ収集（Brave Search）のキーワード巡回ロジック。cloudflare:workers 等の外部依存を持たない
// 純粋なファイルのため、blog.ts を経由せず直接ユニットテストできる（process-import-item.ts と同じ方針）。

// 検索キーワード（BLOG_KEYWORDS）は今後も増減しうるため、cron側の発火回数や配列長を
// ハードコードせず、発火時刻（scheduledTime）から求めた通し番号をキーワード数で割った余りで
// 1キーワードだけを選ぶ。キーワードが増減しても、このロジック・cron設定側とも変更不要で
// 全キーワードを巡回し続けられる（増えれば一巡に要する日数が伸びるだけ緩やかに劣化する）。
export function resolveBlogKeywordIndex(scheduledTime: number, slotDurationMs: number, keywordCount: number): number {
	const tick = Math.floor(scheduledTime / slotDurationMs);
	return tick % keywordCount;
}
