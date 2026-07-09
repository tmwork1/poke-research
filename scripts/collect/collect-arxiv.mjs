// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_QUERY = src/lib/importers/arxiv.ts の searchKeywords 由来の検索式が使われる）。
const importUrl = process.env.ARXIV_IMPORT_URL || 'http://localhost:4321/api/import/arxiv';
const query = process.env.ARXIV_QUERY?.trim() || undefined;
const maxResults = Number(process.env.ARXIV_MAX_RESULTS || '50');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			maxResults,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`arxiv import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
