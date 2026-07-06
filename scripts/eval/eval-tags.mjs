// M5: タグ精度の最適化フロー用スクリプト。
// 実データのタグ使用件数とサンプル記事タイトルを出力する。Claude Code がこれを読み、
// 表記ゆれ・重複・検索性の低いノイズタグ（使用1件のみ等）を判定し、
// 問題があれば src/lib/importers/article-ai.ts の normalizeTagName や
// マイグレーションで是正した上で再実行する、というループの土台として使う。
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
				t.id,
				t.name,
				count(*) AS usage_count,
				(
					SELECT string_agg(i.title, ' / ')
					FROM (
						SELECT i2.title
						FROM item_tags it2
						JOIN items i2 ON i2.id = it2.item_id
						WHERE it2.tag_id = t.id
						ORDER BY i2.id
						LIMIT 3
					) i
				) AS sample_titles
			FROM tags t
			JOIN item_tags it ON it.tag_id = t.id
			GROUP BY t.id, t.name
			ORDER BY usage_count DESC, t.name ASC
		`);

		console.log(`=== タグ一覧 ${rows.length} 件（使用件数の多い順） ===`);
		for (const row of rows) {
			console.log(`\n[${row.name}] 使用: ${row.usage_count}件`);
			console.log(`  例: ${row.sample_titles}`);
		}

		const singleUse = rows.filter((row) => Number(row.usage_count) === 1);
		console.log(`\n=== 使用1件のみのタグ (${singleUse.length}/${rows.length}件、ノイズ候補) ===`);
		console.log(singleUse.map((row) => row.name).join(', '));

		// 上記クエリは tags と item_tags の INNER JOIN のため、使用件数0件のタグ
		// （merge-tag.mjs 統合後の残骸や、作成されたが一度も付与されなかったタグ）が
		// 一覧に出てこない。LEFT JOIN で全タグを対象に取り直し、削除候補として別掲する。
		const { rows: unusedRows } = await client.query(`
			SELECT t.id, t.name
			FROM tags t
			LEFT JOIN item_tags it ON it.tag_id = t.id
			WHERE it.tag_id IS NULL
			ORDER BY t.name ASC
		`);
		console.log(`\n=== 使用0件のタグ (${unusedRows.length}件、削除候補) ===`);
		console.log(unusedRows.map((row) => row.name).join(', '));
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
