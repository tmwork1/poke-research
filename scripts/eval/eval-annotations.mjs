// annotations（GET/POST /api/annotations）の内容を記事タイトルと紐付けて一覧出力する
// 読み取り専用のレビュー用スクリプト。件数が増えてきたときの目視確認に使う。
//
// 使い方: node --env-file=.env scripts/eval/eval-annotations.mjs
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL not set. Use scripts/db/setup-env.ps1 or export env.');
	process.exit(1);
}

async function main() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query(`
			SELECT
				a.id,
				a.item_id,
				i.title AS item_title,
				a.kind,
				a.value,
				a.created_at
			FROM annotations a
			LEFT JOIN items i ON i.id = a.item_id
			ORDER BY a.created_at DESC, a.id DESC
		`);

		console.log(`=== annotations 一覧 ${rows.length} 件（新しい順） ===`);
		for (const row of rows) {
			console.log(`\n[id=${row.id}] item #${row.item_id ?? '-'} "${row.item_title ?? '(削除済み記事)'}"`);
			console.log(`  kind: ${row.kind ?? '-'} / created_at: ${row.created_at?.toISOString?.() ?? row.created_at}`);
			console.log(`  value: ${JSON.stringify(row.value)}`);
		}
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
