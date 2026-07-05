// topic は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_TOPIC = src/lib/importers/keywords.ts の ZENN_TOPICS が使われる）。
const importUrl = process.env.ZENN_IMPORT_URL || 'http://localhost:4321/api/import/zenn';
const topic = process.env.ZENN_TOPIC?.trim() || undefined;
const pages = Number(process.env.ZENN_PAGES || '1');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			topic,
			pages,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Zenn import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
