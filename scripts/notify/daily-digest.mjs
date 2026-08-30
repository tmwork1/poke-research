import { postImport } from '../collect/_client.mjs';

const digestUrl = process.env.DAILY_DIGEST_URL || 'http://localhost:4321/api/notify/daily-digest';
const body = process.env.DIGEST_SINCE ? { since: process.env.DIGEST_SINCE } : {};

async function main() {
	await postImport(digestUrl, body, 'daily digest');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
