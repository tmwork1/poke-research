// link_status='broken' の items を link_broken_since の古い順に一覧出力する
// 読み取り専用のレビュー用スクリプト。一時的なサイト側障害やUser-Agentブロックを
// 恒久的なリンク切れと誤認していないか、月次程度で目視確認する運用を想定する。
//
// 使い方: node --env-file=.env scripts/eval/eval-broken-links.mjs
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
			SELECT id, title, external_url, link_broken_since, link_checked_at
			FROM items
			WHERE link_status = 'broken'
			ORDER BY link_broken_since ASC NULLS LAST, id ASC
		`);

		console.log(`=== リンク切れ item 一覧 ${rows.length} 件（broken確定日時の古い順） ===`);
		for (const row of rows) {
			console.log(`\n[id=${row.id}] ${row.title}`);
			console.log(`  url: ${row.external_url}`);
			console.log(`  broken確定: ${row.link_broken_since?.toISOString?.() ?? row.link_broken_since ?? '-'} / 直近チェック: ${row.link_checked_at?.toISOString?.() ?? row.link_checked_at ?? '-'}`);
		}
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
