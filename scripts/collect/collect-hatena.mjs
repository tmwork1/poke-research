// keyword は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の POKEMON_KEYWORDS = src/lib/importers/keywords.ts の共通リストが使われる）。
const importUrl = process.env.HATENA_IMPORT_URL || 'http://localhost:4321/api/import/hatena';
const keyword = process.env.HATENA_KEYWORD?.trim() || undefined;
const maxCandidatesPerKeyword = Number(process.env.HATENA_MAX_CANDIDATES || '15');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			keyword,
			maxCandidatesPerKeyword,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`hatena import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
