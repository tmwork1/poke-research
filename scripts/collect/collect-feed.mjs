// 登録済みRSS/Atomフィード（feed_subscriptions、migrations/022）を直接ポーリングする収集ジョブを
// 手動起動する薄いPOSTラッパー。
import { postImport } from './_client.mjs';

const importUrl = process.env.FEED_IMPORT_URL || 'http://localhost:4321/api/import/feed';
const maxEntriesPerFeed = Number(process.env.FEED_MAX_ENTRIES || '10');

async function main() {
	await postImport(importUrl, { maxEntriesPerFeed }, 'feed import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
