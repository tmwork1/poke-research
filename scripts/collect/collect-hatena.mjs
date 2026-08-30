// keyword は収集内容の質に直結するため既定値を持たない。明示的に指定した時だけ上書きする
// （未指定なら API 側の POKEMON_KEYWORDS = src/lib/importers/keywords.ts の共通リストが使われる）。
import { postImport } from './_client.mjs';

const importUrl = process.env.HATENA_IMPORT_URL || 'http://localhost:4321/api/import/hatena';
const keyword = process.env.HATENA_KEYWORD?.trim() || undefined;
const maxCandidatesPerKeyword = Number(process.env.HATENA_MAX_CANDIDATES || '15');

async function main() {
	await postImport(importUrl, { keyword, maxCandidatesPerKeyword }, 'hatena import');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
