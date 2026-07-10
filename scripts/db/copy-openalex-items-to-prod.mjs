// 使い捨てスクリプト（2026-07-10 OpenAlex論文収集の初期投入用）。copy-arxiv-items-to-prod.mjs を
// OpenAlex向けに複製したもの。
//
// ローカルで収集・AIレビュー済みの items.collection_route='openalex-importer' を、AIレビュー結果
// ごと本番Supabaseへそのままコピーする。本番でOpenAIレビューを再実行しない（課金の二重発生を
// 避ける）ことが目的。source は OpenAlex 1件のみ、tags/items は external_url・name の
// UNIQUE制約による自然キーで本番側にupsertし、本番採番のidをitem_tagsの関連付けに使う。
//
// 対象は items.collection_route='openalex-importer' のみ（kind='paper'で絞ると本番に既存の
// arXiv分も含まれてしまうため、collection_routeで絞る）。
//
// Usage:
//   node scripts/db/copy-openalex-items-to-prod.mjs --dry-run [--include-rejected]
//   node scripts/db/copy-openalex-items-to-prod.mjs --apply [--include-rejected]
//
// --include-rejected を付けない場合は ai_accepted=true の行のみコピーする。
// --dry-run では本番接続で現状件数を読むだけで書き込みは行わない。
// 実行前に必ず --dry-run で対象件数・内容を確認し、ユーザーの許可を得てから --apply すること
// （本番Supabaseへの書き込みのため、CLAUDE.mdの方針により事前確認が必須）。
//
// このスクリプトは一度きりの初期投入用であり、恒久的な運用スクリプトではない
// （docs/reference/scripts.md には登録しない）。
import fs from 'fs';
import { Client } from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = !apply || args.includes('--dry-run');
const includeRejected = args.includes('--include-rejected');

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

const OPENALEX_ORIGIN_URL = 'https://openalex.org/';

async function main() {
	const localClient = new Client({ connectionString: localEnv.DATABASE_URL });
	const prodClient = new Client({ connectionString: prodEnv.DATABASE_URL });
	await localClient.connect();
	await prodClient.connect();

	try {
		const sourceRes = await localClient.query('select id, name, type, origin_url, metadata from sources where origin_url = $1', [OPENALEX_ORIGIN_URL]);
		if (sourceRes.rows.length === 0) {
			throw new Error('ローカルにOpenAlexソース（sources.origin_url=https://openalex.org/）が見つかりません。先に収集を実行してください。');
		}
		const localSource = sourceRes.rows[0];

		const acceptedFilter = includeRejected ? '' : 'and ai_accepted = true';
		const itemsRes = await localClient.query(
			`select id, external_url, kind, title, authors, summary, published_at, updated_at, metadata, version, body, ai_accepted, language, collection_route
			 from items where collection_route = 'openalex-importer' ${acceptedFilter} order by id`,
		);
		const localItems = itemsRes.rows;
		const acceptedCount = localItems.filter((i) => i.ai_accepted).length;
		const rejectedCount = localItems.length - acceptedCount;

		const itemIds = localItems.map((r) => r.id);
		const tagsByItem = new Map();
		const tagInfoByName = new Map();
		if (itemIds.length > 0) {
			const tagRes = await localClient.query(
				`select it.item_id, t.id as tag_id, t.name, t.display_name
				 from item_tags it join tags t on t.id = it.tag_id
				 where it.item_id = any($1::int[])`,
				[itemIds],
			);
			for (const row of tagRes.rows) {
				if (!tagsByItem.has(row.item_id)) tagsByItem.set(row.item_id, []);
				tagsByItem.get(row.item_id).push(row.name);
				if (!tagInfoByName.has(row.name)) tagInfoByName.set(row.name, row.display_name);
			}
		}
		const uniqueTagNames = [...tagInfoByName.keys()];

		console.log(`[local] source: "${localSource.name}" (${localSource.origin_url})`);
		console.log(
			`[local] コピー対象 items.collection_route='openalex-importer': ${localItems.length} 件` +
				`（ai_accepted=true: ${acceptedCount} 件, false: ${rejectedCount} 件${includeRejected ? '' : '（--include-rejected未指定のため棄却分は対象外）'}）`,
		);
		console.log(`[local] 関連する distinct タグ数: ${uniqueTagNames.length}`);

		const prodExistingRes = await prodClient.query(`select external_url, ai_accepted from items where kind = 'paper'`);
		const prodExistingMap = new Map(prodExistingRes.rows.map((r) => [r.external_url, r.ai_accepted]));
		const toInsert = localItems.filter((i) => !prodExistingMap.has(i.external_url));
		const toUpdate = localItems.filter((i) => prodExistingMap.has(i.external_url));
		const preserveSkip = toUpdate.filter((i) => prodExistingMap.get(i.external_url) === true && i.ai_accepted === false);

		console.log(
			`[prod見込み] 現状 kind='paper' 件数（arXiv含む）: ${prodExistingRes.rows.length} 件 / 新規insert見込み: ${toInsert.length} 件 / ` +
				`既存update見込み: ${toUpdate.length} 件（うち採用済み記事の格下げガードでskipされる件数: ${preserveSkip.length} 件）`,
		);

		console.log('\n--- サンプル（先頭5件） ---');
		for (const item of localItems.slice(0, 5)) {
			const tags = tagsByItem.get(item.id) ?? [];
			console.log(
				`- [${item.ai_accepted ? 'accepted' : 'rejected'}] "${item.title}"\n` +
					`  external_url=${item.external_url}\n` +
					`  tags=[${tags.join(', ')}]\n` +
					`  summary=${(item.summary ?? '').slice(0, 80)}...`,
			);
		}
		if (localItems.length > 5) console.log(`  ...ほか${localItems.length - 5}件`);

		if (dryRun) {
			console.log('\n[dry-run] 本番への書き込みは行っていません。内容を確認のうえ --apply を付けて再実行してください。');
			return;
		}

		console.log('\n本番への書き込みを開始します...');
		await prodClient.query('BEGIN');
		try {
			const sourceUpsert = await prodClient.query(
				`insert into sources (name, type, origin_url, metadata) values ($1, $2, $3, $4)
				 on conflict (origin_url) do update set name = excluded.name, type = excluded.type, metadata = excluded.metadata
				 returning id`,
				[localSource.name, localSource.type, localSource.origin_url, localSource.metadata],
			);
			const prodSourceId = sourceUpsert.rows[0].id;

			const tagIdByName = new Map();
			for (const name of uniqueTagNames) {
				const displayName = tagInfoByName.get(name) ?? null;
				const res = await prodClient.query(
					`insert into tags (name, display_name) values ($1, $2)
					 on conflict (name) do update set display_name = coalesce(tags.display_name, excluded.display_name)
					 returning id`,
					[name, displayName],
				);
				tagIdByName.set(name, res.rows[0].id);
			}

			let inserted = 0;
			let updated = 0;
			let skippedPreserve = 0;
			let itemTagsWritten = 0;

			for (const item of localItems) {
				const existing = await prodClient.query('select id, ai_accepted from items where external_url = $1', [item.external_url]);
				if (existing.rows.length > 0 && existing.rows[0].ai_accepted === true && item.ai_accepted === false) {
					// upsertItemByExternalUrl の shouldPreserveAcceptedItem と同じ方針:
					// 既に公開中（採用済み）の記事を棄却判定で格下げしない。
					skippedPreserve += 1;
					continue;
				}
				const isNew = existing.rows.length === 0;

				const itemUpsert = await prodClient.query(
					`insert into items (source_id, external_url, kind, title, authors, summary, published_at, updated_at, metadata, version, body, ai_accepted, language, collection_route)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
					 on conflict (external_url) do update set
					   source_id = excluded.source_id, kind = excluded.kind, title = excluded.title, authors = excluded.authors,
					   summary = excluded.summary, published_at = excluded.published_at, updated_at = excluded.updated_at,
					   metadata = excluded.metadata, version = excluded.version, body = excluded.body,
					   ai_accepted = excluded.ai_accepted, language = excluded.language, collection_route = excluded.collection_route
					 returning id`,
					[
						prodSourceId,
						item.external_url,
						item.kind,
						item.title,
						item.authors,
						item.summary,
						item.published_at,
						item.updated_at,
						item.metadata,
						item.version,
						item.body,
						item.ai_accepted,
						item.language,
						item.collection_route,
					],
				);
				const prodItemId = itemUpsert.rows[0].id;
				if (isNew) inserted += 1;
				else updated += 1;

				const tags = tagsByItem.get(item.id) ?? [];
				if (tags.length > 0) {
					await prodClient.query('delete from item_tags where item_id = $1', [prodItemId]);
					for (const tagName of tags) {
						const tagId = tagIdByName.get(tagName);
						await prodClient.query('insert into item_tags (item_id, tag_id) values ($1, $2) on conflict (item_id, tag_id) do nothing', [
							prodItemId,
							tagId,
						]);
						itemTagsWritten += 1;
					}
				}
			}

			await prodClient.query('COMMIT');
			console.log(
				`\n本番への書き込みが完了しました: items inserted=${inserted}, updated=${updated}, preserve-skip=${skippedPreserve}, ` +
					`item_tags書き込み=${itemTagsWritten}, tags upsert=${uniqueTagNames.length}`,
			);
		} catch (e) {
			await prodClient.query('ROLLBACK');
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
