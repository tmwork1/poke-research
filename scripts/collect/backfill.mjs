// 過去記事の一括バックフィル実行スクリプト。
// 通常の cron（毎日の増分収集）より広い範囲を一度に取り込むため、pages/perPage を
// 引き上げて各インポーター API を順番に叩く。note は単一クエリしか受けないため、
// keywords.ts 相当の日本語キーワードでクエリを変えながら複数回呼ぶ。
//
// 使い方:
//   ローカル:  node scripts/collect/backfill.mjs
//   本番:      IMPORT_BASE_URL=https://poke-research.com ADMIN_USERNAME=... ADMIN_PASSWORD=... \
//              node scripts/collect/backfill.mjs
//
// 対象を絞る場合は BACKFILL_TARGETS=qiita,zenn のようにカンマ区切りで指定する。
// OpenAI 課金と各 API のレートリミットに注意し、本番実行はユーザー確認を得てから行う。

// 1リクエストで数百件のAIレビューを待つため、undici 既定の5分ヘッダタイムアウトを無効化する
//（undici は vite 経由で node_modules に存在する transitive 依存）。
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const baseUrl = (process.env.IMPORT_BASE_URL || 'http://localhost:4321').replace(/\/$/, '');
const targets = (process.env.BACKFILL_TARGETS || 'qiita,zenn,note,blog').split(',').map((t) => t.trim());

// 増分収集の既定値（Qiita 1x20 / note 1x10 / Zenn 1ページ）より広めの既定値。
// Qiita API は per_page 最大100・検索は認証なしだと60req/h なので pages は控えめにする。
const qiitaPages = Number(process.env.BACKFILL_QIITA_PAGES || '3');
const qiitaPerPage = Number(process.env.BACKFILL_QIITA_PER_PAGE || '100');
const zennPages = Number(process.env.BACKFILL_ZENN_PAGES || '5');
const notePages = Number(process.env.BACKFILL_NOTE_PAGES || '3');
const notePerPage = Number(process.env.BACKFILL_NOTE_PER_PAGE || '20');
const noteQueries = (process.env.BACKFILL_NOTE_QUERIES || 'ポケモン,ポケカ,ポケモンカード')
	.split(',')
	.map((q) => q.trim())
	.filter(Boolean);

function buildHeaders() {
	const headers = { 'Content-Type': 'application/json' };
	// 本番の /api/import/** は Basic 認証で保護されているため、資格情報があれば付ける。
	const user = process.env.ADMIN_USERNAME;
	const pass = process.env.ADMIN_PASSWORD;
	if (user && pass) {
		headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
	}
	return headers;
}

async function runImport(provider, body) {
	const response = await fetch(`${baseUrl}/api/import/${provider}`, {
		method: 'POST',
		headers: buildHeaders(),
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${provider} import failed (${response.status}): ${text.slice(0, 500)}`);
	}
	return JSON.parse(text).data;
}

function summarize(provider, result) {
	console.log(
		`[${provider}] fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`,
	);
	// AI 判定基準の厳しさを検証できるよう、棄却理由の内訳を残す。
	const reasons = new Map();
	for (const item of result.items ?? []) {
		if (item.action !== 'skipped' || !item.reason) continue;
		reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
	}
	for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
		console.log(`  skipped x${count}: ${reason.slice(0, 160)}`);
	}
	return { fetched: result.fetched ?? 0, inserted: result.inserted ?? 0, updated: result.updated ?? 0, skipped: result.skipped ?? 0 };
}

async function main() {
	const totals = { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
	const add = (s) => {
		totals.fetched += s.fetched;
		totals.inserted += s.inserted;
		totals.updated += s.updated;
		totals.skipped += s.skipped;
	};

	if (targets.includes('qiita')) {
		add(summarize('qiita', await runImport('qiita', { pages: qiitaPages, perPage: qiitaPerPage, token: process.env.QIITA_TOKEN || undefined })));
	}
	if (targets.includes('zenn')) {
		add(summarize('zenn', await runImport('zenn', { pages: zennPages })));
	}
	if (targets.includes('note')) {
		for (const query of noteQueries) {
			console.log(`[note] query=${query}`);
			add(summarize('note', await runImport('note', { query, pages: notePages, perPage: notePerPage })));
		}
	}
	if (targets.includes('blog')) {
		add(summarize('blog', await runImport('blog', {})));
	}

	console.log(`\n[total] fetched=${totals.fetched} inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
