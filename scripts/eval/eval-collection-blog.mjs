// M5: Brave Search（個人ブログ収集）の収集クエリ精度の最適化フロー用スクリプト。
// eval-collection.mjs の Qiita/Zenn/note 版と同じ考え方で、AIレビュー・本文抽出にかける前の
// Brave Search の生の検索結果（タイトル・URL）を BLOG_KEYWORDS ごとに出力する。
// OpenAI もHTML本文取得も行わない。Claude Code がこの出力を読み、ポケモンのプログラミング・
// 開発と無関係な記事（ゴミ）がどれだけ混ざっているかを自分で判定し、割合が高ければ
// src/lib/importers/keywords.ts の BLOG_KEYWORDS/EXCLUDED_BLOG_DOMAINS/FILTERED_BLOG_DOMAINS
// を見直して再実行する、というループの土台として使う。
//
// 注意（実装上の重複について）: src/lib/brave.ts・src/lib/importers/{blog,keywords}.ts の一部は
// `cloudflare:workers` に依存する importers/*.ts からのみ import されるか、実行時に
// import.meta 経由でしか読めないためプレーンな Node スクリプトから直接 import せず、
// 同等のロジック（クエリ組み立て・除外ドメイン判定）をここに複製する。ただしトピック固有の
// キーワード・除外ドメインは cloudflare:workers に依存しない src/config/topic.config.mjs を
// 直接 import するため、トピック設定を変更してもここを個別に直す必要はない。

import { topic } from '../../src/config/topic.config.mjs';

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

const BLOG_KEYWORDS = topic.collection.blogSearchKeywords;

// src/lib/importers/keywords.ts の EXCLUDED_BLOG_DOMAINS（クエリの -site: と結果フィルタの両方で使う）。
// 先頭の共通ドメインはトピックに依らないためここでも直書きし、トピック固有分だけ config から取る。
const EXCLUDED_BLOG_DOMAINS = [
	'qiita.com', 'zenn.dev', 'note.com', 'github.com', 'youtube.com', 'x.com', 'twitter.com',
	...topic.collection.extraExcludedBlogDomains,
];

// 同ファイルの FILTERED_BLOG_DOMAINS（結果フィルタのみ、クエリの -site: には含めない）。
const FILTERED_BLOG_DOMAINS = ['b.hatena.ne.jp', 'pinterest.com', 'sourceforge.net', 'play.google.com', 'apps.apple.com'];

function isExcludedBlogDomain(hostname) {
	const normalized = hostname.replace(/^www\./, '');
	return [...EXCLUDED_BLOG_DOMAINS, ...FILTERED_BLOG_DOMAINS].some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

function buildSearchQuery(keyword) {
	const exclusions = EXCLUDED_BLOG_DOMAINS.map((domain) => `-site:${domain}`).join(' ');
	return `${keyword} ${exclusions}`;
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

function printSection(keyword, query, results) {
	const excludedCount = results.filter((r) => isExcludedBlogDomain(new URL(r.url).hostname)).length;
	console.log(`\n=== キーワード: "${keyword}" ${results.length}件（うち除外ドメイン ${excludedCount}件） ===`);
	console.log(`クエリ: ${query}`);
	results.forEach((r, i) => {
		const hostname = new URL(r.url).hostname;
		const flag = isExcludedBlogDomain(hostname) ? ' [除外ドメイン]' : '';
		console.log(`${i + 1}. ${r.title}${flag}`);
		console.log(`   ${hostname} — ${r.url}`);
	});
}

async function main() {
	const apiKey = process.env.BRAVE_API_KEY?.trim();
	if (!apiKey) {
		console.error('BRAVE_API_KEY not set. scripts/db/setup-env.ps1 等で .env を読み込むこと。');
		process.exit(1);
	}

	// Brave 無料枠（月1000件≒1日30件）を消費するため、既定は各キーワード1ページ（count=20）
	// = 合計6リクエストに抑える。多く見たい場合のみ env で上書きする。
	const count = Number(process.env.BLOG_EVAL_COUNT || '20');
	const pages = Number(process.env.BLOG_EVAL_PAGES || '1');
	const onlyKeyword = process.env.BLOG_EVAL_KEYWORD?.trim();
	const keywords = onlyKeyword ? [onlyKeyword] : BLOG_KEYWORDS;

	console.log('AIレビュー・本文抽出前の生のBrave Search結果（タイトル・URLのみ）。ポケモンの');
	console.log('プログラミング・開発と無関係な記事（ゴミ）がどれだけ混ざっているか、除外ドメインの');
	console.log('判定漏れがないかを、Claude Codeがこれを見て判定すること。');
	console.log(`(count=${count}, pages(1キーワードあたり)=${pages}, 消費リクエスト数見込み=${keywords.length * pages})`);

	for (const keyword of keywords) {
		const query = buildSearchQuery(keyword);
		const results = [];
		for (let page = 0; page < pages; page += 1) {
			const pageResults = await braveWebSearch(apiKey, query, { count, offset: page });
			results.push(...pageResults);
			if (pageResults.length < count) break;
		}
		printSection(keyword, query, results);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
