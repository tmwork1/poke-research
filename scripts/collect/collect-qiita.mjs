// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_QUERY = src/lib/importers/keywords.ts の共通リストが使われる）。
import { postImport } from './_client.mjs';

const importUrl = process.env.QIITA_IMPORT_URL || 'http://localhost:4321/api/import/qiita';
const query = process.env.QIITA_QUERY?.trim() || undefined;
const pages = Number(process.env.QIITA_PAGES || '1');
const perPage = Number(process.env.QIITA_PER_PAGE || '20');
const token = process.env.QIITA_TOKEN || '';

async function main() {
	await postImport(importUrl, { query, pages, perPage, token }, 'Qiita import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
