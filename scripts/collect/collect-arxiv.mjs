// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_QUERY = src/lib/importers/arxiv.ts の searchKeywords 由来の検索式が使われる）。
import { postImport } from './_client.mjs';

const importUrl = process.env.ARXIV_IMPORT_URL || 'http://localhost:4321/api/import/arxiv';
const query = process.env.ARXIV_QUERY?.trim() || undefined;
const maxResults = Number(process.env.ARXIV_MAX_RESULTS || '50');

async function main() {
	await postImport(importUrl, { query, maxResults }, 'arxiv import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
