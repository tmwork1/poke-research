// リンク切れ検出ジョブ（POST /api/import/check-links）を手動起動するラッパー。
// バッチ件数等は API 側の既定値（src/lib/importers/link-check.ts）をそのまま使い、
// 明示的に指定した時だけ上書きする。
const importUrl = process.env.CHECK_LINKS_IMPORT_URL || 'http://localhost:4321/api/import/check-links';
const batchLimit = process.env.LINK_CHECK_BATCH_LIMIT ? Number(process.env.LINK_CHECK_BATCH_LIMIT) : undefined;
const concurrency = process.env.LINK_CHECK_CONCURRENCY ? Number(process.env.LINK_CHECK_CONCURRENCY) : undefined;
const recheckIntervalDays = process.env.LINK_CHECK_RECHECK_DAYS ? Number(process.env.LINK_CHECK_RECHECK_DAYS) : undefined;

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			batchLimit,
			concurrency,
			recheckIntervalDays,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`link check failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
