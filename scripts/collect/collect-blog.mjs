// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の POKEMON_KEYWORDS = src/lib/importers/keywords.ts の共通リストが使われる）。
const importUrl = process.env.BLOG_IMPORT_URL || 'http://localhost:4321/api/import/blog';
const query = process.env.BLOG_QUERY?.trim() || undefined;
const count = Number(process.env.BRAVE_COUNT || '20');
const pages = Number(process.env.BLOG_PAGES || '15');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			count,
			pages,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`blog import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
