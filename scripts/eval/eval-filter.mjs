// M5: AI取り込みレビュー(フィルタ)精度の最適化フロー用スクリプト。
// src/lib/importers/article-ai.ts の現在のシステムプロンプトと、
// 実際に収集済みの記事(title/summary/tags/AIの採否・理由)を並べて出力する。
// OpenAI を実際に呼ぶとコストがかかるため、ここでは「採点」はせず、
// Claude Code が出力を読んで現行プロンプトの基準に照らして自分で再判定し、
// ズレ(本来falseにすべきなのにtrueになっている等)を見つけたらプロンプトを修正、
// 再実行して確認する、というループの土台として使う。
import { readFile } from 'fs/promises';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL not set. Use scripts/db/setup-env.ps1 or export env.');
	process.exit(1);
}

async function printCurrentPrompt() {
	const source = await readFile(new URL('../../src/lib/importers/article-ai.ts', import.meta.url), 'utf8');
	const match = source.match(/content:\s*\n?\s*'([^']*(?:\\'[^']*)*)'/);
	console.log('=== 現在のシステムプロンプト (src/lib/importers/article-ai.ts) ===');
	console.log(match ? match[1].replace(/\\'/g, "'") : '(抽出失敗: ファイル構造が変わった可能性)');
	console.log('');
}

async function printCases(client) {
	const { rows } = await client.query(`
		SELECT
			i.id,
			s.name AS source_name,
			i.title,
			i.summary,
			(SELECT string_agg(t.name, ',') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id) AS tags,
			i.metadata->'ai'->>'accepted' AS ai_accepted,
			i.metadata->'ai'->>'reason' AS ai_reason,
			i.metadata->'ai'->>'confidence' AS ai_confidence
		FROM items i
		JOIN sources s ON s.id = i.source_id
		ORDER BY i.id
	`);

	console.log(`=== 収集済み記事 ${rows.length} 件（現行プロンプトの基準で再判定してください） ===`);
	for (const row of rows) {
		console.log(`\n[id=${row.id}] (${row.source_name}) ${row.title}`);
		console.log(`  summary: ${(row.summary ?? '').replace(/\n/g, ' ')}`);
		console.log(`  tags: ${row.tags ?? ''}`);
		console.log(`  収集時のAI判定: accepted=${row.ai_accepted} confidence=${row.ai_confidence} reason=${row.ai_reason}`);
	}
}

async function main() {
	await printCurrentPrompt();
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await printCases(client);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
