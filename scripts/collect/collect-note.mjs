// query は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の DEFAULT_QUERY = src/lib/importers/keywords.ts の共通リストが使われる）。
import { postImport } from './_client.mjs';

const importUrl = process.env.NOTE_IMPORT_URL || 'http://localhost:4321/api/import/note';
const query = process.env.NOTE_QUERY?.trim() || undefined;
const pages = Number(process.env.NOTE_PAGES || '1');

async function main() {
	await postImport(importUrl, { query, pages }, 'note import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
