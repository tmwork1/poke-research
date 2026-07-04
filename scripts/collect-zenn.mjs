const importUrl = process.env.ZENN_IMPORT_URL || 'http://localhost:4321/api/import/zenn';
const topic = process.env.ZENN_TOPIC || 'pokemon';
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
