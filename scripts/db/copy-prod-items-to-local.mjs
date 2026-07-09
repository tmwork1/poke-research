// 使い捨てスクリプト（2026-07-09 ゴミアイテム調査のための本番スナップショット取得用）。
//
// 本番Supabaseの sources/items/tags/item_tags を読み取り専用で取得し、
// ローカルDBの同テーブルを丸ごと置き換える（TRUNCATE ... CASCADE後に再投入）。
// id・シーケンスも本番の値に合わせるため、ローカルの既存データ（テスト収集の蓄積分）は失われる。
//
// Usage:
//   node --env-file=.env scripts/db/copy-prod-items-to-local.mjs --apply
//
// 本番へは一切書き込まない（SELECTのみ）。ローカルへの書き込みのみ行う。
// このスクリプトは一度きりの調査用であり、恒久的な運用スクリプトではない
// （docs/reference/scripts.md には登録しない）。
import fs from 'fs';
import { Client } from 'pg';

const apply = process.argv.includes('--apply');

function parseEnvFile(path) {
	const text = fs.readFileSync(path, 'utf8');
	const env = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

const localEnv = parseEnvFile('.env');
const prodEnv = parseEnvFile('.env.production');

if (!localEnv.DATABASE_URL) {
	console.error('.env に DATABASE_URL がありません（ローカルDB接続用）。');
	process.exit(1);
}
if (!prodEnv.DATABASE_URL) {
	console.error('.env.production に DATABASE_URL がありません（本番DB接続用）。');
	process.exit(1);
}

async function main() {
	const localClient = new Client({ connectionString: localEnv.DATABASE_URL });
	const prodClient = new Client({ connectionString: prodEnv.DATABASE_URL });
	await localClient.connect();
	await prodClient.connect();

	try {
		const sources = (await prodClient.query('select id, name, type, origin_url, metadata, created_at from sources order by id')).rows;
		const items = (
			await prodClient.query(
				`select id, source_id, external_url, kind, title, authors, summary, published_at, updated_at, metadata, version,
				        created_at, bookmarks_count, body, link_status, link_checked_at, link_broken_since, ai_accepted, language, collection_route
				 from items order by id`,
			)
		).rows;
		const tags = (await prodClient.query('select id, name, is_difficult, explanation, explained_at, display_name from tags order by id')).rows;
		const itemTags = (await prodClient.query('select item_id, tag_id from item_tags')).rows;

		console.log(`[prod] sources=${sources.length}, items=${items.length}, tags=${tags.length}, item_tags=${itemTags.length}`);

		if (!apply) {
			console.log('\n[dry-run] ローカルへの書き込みは行っていません。内容を確認のうえ --apply を付けて再実行してください。');
			return;
		}

		console.log('\nローカルDBの置き換えを開始します...');
		await localClient.query('BEGIN');
		try {
			await localClient.query('TRUNCATE annotations, bookmarks, item_tags, items, sources, tags RESTART IDENTITY CASCADE');

			for (const s of sources) {
				await localClient.query(
					'insert into sources (id, name, type, origin_url, metadata, created_at) values ($1,$2,$3,$4,$5,$6)',
					[s.id, s.name, s.type, s.origin_url, s.metadata, s.created_at],
				);
			}
			for (const t of tags) {
				await localClient.query(
					'insert into tags (id, name, is_difficult, explanation, explained_at, display_name) values ($1,$2,$3,$4,$5,$6)',
					[t.id, t.name, t.is_difficult, t.explanation, t.explained_at, t.display_name],
				);
			}
			for (const i of items) {
				await localClient.query(
					`insert into items (id, source_id, external_url, kind, title, authors, summary, published_at, updated_at, metadata, version,
					                    created_at, bookmarks_count, body, link_status, link_checked_at, link_broken_since, ai_accepted, language, collection_route)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
					[
						i.id, i.source_id, i.external_url, i.kind, i.title, i.authors, i.summary, i.published_at, i.updated_at,
						i.metadata, i.version, i.created_at, i.bookmarks_count, i.body, i.link_status, i.link_checked_at,
						i.link_broken_since, i.ai_accepted, i.language, i.collection_route,
					],
				);
			}
			for (const it of itemTags) {
				await localClient.query('insert into item_tags (item_id, tag_id) values ($1,$2)', [it.item_id, it.tag_id]);
			}

			for (const [table, col] of [['sources', 'id'], ['items', 'id'], ['tags', 'id']]) {
				await localClient.query(
					`select setval(pg_get_serial_sequence('${table}', '${col}'), coalesce((select max(${col}) from ${table}), 1))`,
				);
			}

			await localClient.query('COMMIT');
			console.log(`\nローカルDBの置き換えが完了しました: sources=${sources.length}, items=${items.length}, tags=${tags.length}, item_tags=${itemTags.length}`);
		} catch (e) {
			await localClient.query('ROLLBACK');
			throw e;
		}
	} finally {
		await localClient.end();
		await prodClient.end();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
