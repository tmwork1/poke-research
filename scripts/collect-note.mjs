const importUrl = process.env.NOTE_IMPORT_URL || 'http://localhost:4321/api/import/note';
const query = process.env.NOTE_QUERY || 'ポケモン';
const pages = Number(process.env.NOTE_PAGES || '1');

async function main() {
	const response = await fetch(importUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			pages,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`note import failed (${response.status}): ${text}`);
	}

	console.log(text);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
