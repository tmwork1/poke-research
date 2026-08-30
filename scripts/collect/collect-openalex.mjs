import { postImport } from './_client.mjs';

const importUrl = process.env.OPENALEX_IMPORT_URL || 'http://localhost:4321/api/import/openalex';
const filter = process.env.OPENALEX_FILTER?.trim() || undefined;
const maxResults = Number(process.env.OPENALEX_MAX_RESULTS || '20');
const page = Number(process.env.OPENALEX_PAGE || '1');

async function main() {
	await postImport(importUrl, { filter, maxResults, page }, 'OpenAlex import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
