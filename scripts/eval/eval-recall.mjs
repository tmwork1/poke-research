// 収集アルゴリズムの再現率（recall）チェック用スクリプト。
// eval-collection*.mjs が「収集された生データのうちゴミがどれだけ混ざっているか」という
// 適合率（precision）側の確認なのに対し、こちらは逆方向: Brave Search で対象ソースの
// ドメインに絞って「よく知られていそうな候補」を独立に探し、DB（items.external_url）に
// 既に存在するかどうかを突き合わせて、収集クエリの見落とし（false negative）候補を洗い出す。
// OpenAI は呼ばない。Claude Code がここに出た「DB未収録」候補を読み、実際に主題外なのか
// （タイトルだけでは無関係な同名語などが混ざりうる）、それとも各インポーターの
// DEFAULT_QUERY（qiita.ts/zenn.ts/arxiv.ts等）の見落としなのかを判定し、後者であれば
// クエリを修正して再収集する、というループの土台として使う。
//
// 実例: arXivの検索インデックスがアクセント記号のfoldingを行わないため、"Pokémon"表記
// （アクセント付きé）のみを使う論文がall:pokemonの収集クエリから漏れていたことを
// このスクリプトと同じ発想の手動確認で発見した（2026-07-09、docs/plan/paper.md）。
//
// Usage:
//   node --env-file=.env scripts/eval/eval-recall.mjs --source=arxiv
//   node --env-file=.env scripts/eval/eval-recall.mjs --source=qiita --keyword=ポケモン
//
// --source は下記 SOURCES のキーのいずれか。--keyword 省略時は topic.collection.searchKeywords
// を全て試す（ドメインによってはBrave無料枠を消費するため、確認したいキーワードだけに
// 絞りたい場合は明示指定すること）。
import { Client } from 'pg';
import { topic } from '../../src/config/topic.config.mjs';

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

// ドメインで一意にソースを特定できるものだけを対象にする。blog（Brave収集）・hatena
// （全ウェブ横断のブックマーク検索）は特定ドメインを持たないため対象外
// （両者は「独立した第二の発見経路」という前提が成り立たない）。
const SOURCES = {
	arxiv: { domain: 'arxiv.org', kind: 'paper' },
	qiita: { domain: 'qiita.com', kind: 'article' },
	zenn: { domain: 'zenn.dev', kind: 'article' },
	note: { domain: 'note.com', kind: 'article' },
};

function parseArgs(argv) {
	const args = {};
	for (const arg of argv) {
		const match = arg.match(/^--([^=]+)=(.*)$/);
		if (match) args[match[1]] = match[2];
	}
	return args;
}

async function braveWebSearch(apiKey, query, { count, offset }) {
	const url = new URL(BRAVE_WEB_SEARCH_URL);
	url.searchParams.set('q', query);
	url.searchParams.set('count', String(count));
	url.searchParams.set('offset', String(offset));
	url.searchParams.set('search_lang', 'jp');
	url.searchParams.set('country', 'JP');

	const response = await fetch(url, {
		headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
	});
	if (!response.ok) {
		throw new Error(`Brave Search API failed (${response.status}): ${await response.text()}`);
	}
	const payload = await response.json();
	return payload.web?.results ?? [];
}

// arXivはDB側（items.external_url）が常に /abs/ パスで、末尾のバージョン番号（vN）も
// 改訂のたびに上がる（src/lib/importers/arxiv.ts の canonicalizeAbsUrl と同じ正規化）。
// 加えてBrave Searchは同じ論文でも /abs/・/html/・/pdf/ の異なるパスを返すことがあるため、
// パス種別を無視してID部分だけを取り出し、常に /abs/<id> の形に揃える。
// それ以外のドメインは origin+pathname（末尾スラッシュ・クエリ文字列・フラグメントを除く）で比較する。
function normalizeUrl(rawUrl, sourceKey) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	url.protocol = 'https:';
	if (sourceKey === 'arxiv') {
		const match = url.pathname.match(/\/(?:abs|html|pdf)\/([^/]+?)(?:v\d+)?(?:\.pdf)?$/);
		if (match) return `https://arxiv.org/abs/${match[1]}`;
		return url.toString().replace(/v\d+$/, '');
	}
	const pathname = url.pathname.replace(/\/$/, '');
	return `${url.origin}${pathname}`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourceKey = args.source?.trim();
	const source = sourceKey ? SOURCES[sourceKey] : undefined;
	if (!source) {
		console.error(`--source は次のいずれかを指定してください: ${Object.keys(SOURCES).join(', ')}`);
		process.exit(1);
	}

	const apiKey = process.env.BRAVE_API_KEY?.trim();
	if (!apiKey) {
		console.error('BRAVE_API_KEY not set. scripts/db/setup-env.ps1 等で .env を読み込むこと。');
		process.exit(1);
	}
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL not set. node --env-file=.env で実行すること。');
		process.exit(1);
	}

	const keywords = args.keyword?.trim() ? [args.keyword.trim()] : topic.collection.searchKeywords;
	const count = Number(process.env.RECALL_EVAL_COUNT || '20');

	console.log(`収集アルゴリズムの再現率チェック（ソース: ${sourceKey}, ドメイン: site:${source.domain}）`);
	console.log('Brave Searchで独立に見つけた候補と、DB収録済み記事（external_url）を突き合わせる。');
	console.log('「DB未収録」候補は、無関係な同名語の可能性と、収集クエリの見落としの可能性の両方があるため、');
	console.log('Claude Codeが個別に内容を確認し、後者であればインポーターのDEFAULT_QUERYを見直すこと。\n');

	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	let existingUrls;
	try {
		const res = await client.query('select external_url from items where kind = $1', [source.kind]);
		existingUrls = new Set(res.rows.map((r) => normalizeUrl(r.external_url, sourceKey)));
	} finally {
		await client.end();
	}
	console.log(`DB収録済み（kind='${source.kind}'）: ${existingUrls.size} 件\n`);

	const seen = new Set();
	const gaps = [];
	let totalCandidates = 0;

	for (const keyword of keywords) {
		const query = `site:${source.domain} ${keyword}`;
		const results = await braveWebSearch(apiKey, query, { count, offset: 0 });
		console.log(`=== キーワード: "${keyword}"（クエリ: ${query}） ${results.length}件 ===`);

		for (const result of results) {
			const normalized = normalizeUrl(result.url, sourceKey);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			totalCandidates += 1;

			const inDb = existingUrls.has(normalized);
			console.log(`${inDb ? '[収録済み]' : '[未収録]  '} ${result.title}`);
			console.log(`   ${result.url}`);
			if (!inDb) gaps.push({ title: result.title, url: result.url });
		}
	}

	console.log(`\n=== 結果: 候補${totalCandidates}件中、DB未収録 ${gaps.length}件 ===`);
	if (gaps.length > 0) {
		gaps.forEach((g, i) => console.log(`${i + 1}. ${g.title}\n   ${g.url}`));
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
