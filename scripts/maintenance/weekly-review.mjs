import { postImport } from '../collect/_client.mjs';

const reviewUrl = process.env.WEEKLY_REVIEW_URL || 'http://localhost:4321/api/maintenance/weekly-review';

async function main() {
	await postImport(reviewUrl, {}, 'weekly review');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
