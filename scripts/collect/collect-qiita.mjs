// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_QUERY = src/lib/importers/keywords.ts の共通リストが使われる）。
const importUrl = process.env.QIITA_IMPORT_URL || 'http://localhost:4321/api/import/qiita';
const query = process.env.QIITA_QUERY?.trim() || undefined;
const pages = Number(process.env.QIITA_PAGES || '1');
const perPage = Number(process.env.QIITA_PER_PAGE || '20');
const token = process.env.QIITA_TOKEN || '';

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			pages,
			perPage,
			token,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Qiita import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
