// M5: AI取り込みレビュー(フィルタ)精度の最適化フロー用スクリプト。
// src/lib/importers/article-ai.ts の現在のシステムプロンプトと、
// 実際に収集済みの記事(title/summary/tags/AIの採否・理由)を並べて出力する。
// OpenAI を実際に呼ぶとコストがかかるため、ここでは「採点」はせず、
// Claude Code が出力を読んで現行プロンプトの基準に照らして自分で再判定し、
// ズレ(本来falseにすべきなのにtrueになっている等)を見つけたらプロンプトを修正、
// 再実行して確認する、というループの土台として使う。
//
// 「偽陰性（AIに誤って棄却された記事）」セクション（案A、migrations/018）は、
// 棄却記事も items に保存するようになったことを利用して、通常セクションとは
// 別に一覧表示する。棄却判定は
// items.metadata->'ai'->>'accepted' = 'false' で行い、ai_accepted 列（マイグレーション
// 未適用のDBには存在しない）には依存しない。
import { Client } from 'pg';
import { topic } from '../../src/config/topic.config.mjs';
import { buildSystemPrompt } from '../../src/lib/importers/ai-review-prompt.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL not set. Use scripts/db/setup-env.ps1 or export env.');
	process.exit(1);
}

async function printCurrentPrompt() {
	console.log('=== 現在のシステムプロンプト (src/lib/importers/ai-review-prompt.mjs: buildSystemPrompt) ===');
	console.log(buildSystemPrompt(topic));
	console.log('');
}

async function printCases(client) {
	// 案A（migrations/018）以降は棄却記事も items に保存されるため、ここは従来どおり
	// 「採用済み記事の一覧」のままにするために accepted=false を明示的に除外する
	// （ai フィールド自体が無い行は無い想定だが、無い場合も従来どおり残す）。
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
		WHERE i.metadata->'ai'->>'accepted' IS DISTINCT FROM 'false'
		ORDER BY i.id
	`);

	console.log(`=== 収集済み記事（採用分） ${rows.length} 件（現行プロンプトの基準で再判定してください） ===`);
	for (const row of rows) {
		console.log(`\n[id=${row.id}] (${row.source_name}) ${row.title}`);
		console.log(`  summary: ${(row.summary ?? '').replace(/\n/g, ' ')}`);
		console.log(`  tags: ${row.tags ?? ''}`);
		console.log(`  収集時のAI判定: accepted=${row.ai_accepted} confidence=${row.ai_confidence} reason=${row.ai_reason}`);
	}
}

async function printRejectedCases(client) {
	// 偽陰性（AIに誤って棄却された記事）レビュー用セクション。案Aで棄却記事も items に
	// 保存されるようになったため、ここで新しい順に一覧化し、Claude Code が読んで
	// 現行プロンプトの基準に照らして誤棄却でないか判定できるようにする。
	// ai_accepted 列（migrations/018）ではなく metadata->'ai'->>'accepted' を条件にすることで、
	// マイグレーション未適用のDBに対しても列が無くてエラーにならず動く。
	const { rows } = await client.query(`
		SELECT
			i.id,
			s.name AS source_name,
			i.title,
			i.external_url,
			i.summary,
			i.metadata->'ai'->>'reason' AS ai_reason,
			i.metadata->'ai'->>'confidence' AS ai_confidence,
			i.created_at
		FROM items i
		JOIN sources s ON s.id = i.source_id
		WHERE i.metadata->'ai'->>'accepted' = 'false'
		ORDER BY i.created_at DESC
	`);

	console.log(`\n=== AIに棄却された記事（偽陰性候補） ${rows.length} 件（誤棄却でないか確認してください） ===`);
	for (const row of rows) {
		console.log(`\n[id=${row.id}] (${row.source_name}) ${row.title}`);
		console.log(`  url: ${row.external_url ?? ''}`);
		console.log(`  棄却理由: confidence=${row.ai_confidence} reason=${row.ai_reason}`);
		console.log(`  AI要約: ${(row.summary ?? '').replace(/\n/g, ' ')}`);
	}
}

async function main() {
	await printCurrentPrompt();
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await printCases(client);
		await printRejectedCases(client);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
