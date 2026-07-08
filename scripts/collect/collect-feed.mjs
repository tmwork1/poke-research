// 登録済みRSS/Atomフィード（feed_subscriptions、migrations/022）を直接ポーリングする収集ジョブを
// 手動起動する薄いPOSTラッパー。
const importUrl = process.env.FEED_IMPORT_URL || 'http://localhost:4321/api/import/feed';
const maxEntriesPerFeed = Number(process.env.FEED_MAX_ENTRIES || '10');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			maxEntriesPerFeed,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`feed import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
