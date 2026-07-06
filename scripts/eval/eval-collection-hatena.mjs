// はてなブックマーク検索RSS収集の収集クエリ精度を検証するスクリプト。
// eval-collection-blog.mjs と同じ考え方で、AIレビュー・本文取得にかける前の
// b.hatena.ne.jp/search/text?...&mode=rss の生の検索結果（タイトル・URL）を
// POKEMON_KEYWORDS ごとに出力する。OpenAIもHTML本文取得も行わない。
// Claude Codeがこの出力を読み、ポケモンのプログラミング・開発と無関係な記事（ゴミ）が
// どれだけ混ざっているかを自分で判定する、というループの土台として使う。
//
// 注意（実装上の重複について）: src/lib/importers/{hatena,hatena-feed,keywords}.ts の一部は
// cloudflare:workers に依存する importers/*.ts からのみ import されるか、実行時に
// import.meta 経由でしか読めないためプレーンな Node スクリプトから直接 import せず、
// 同等のロジック（RSSパース・除外ドメイン判定）をここに複製する。ただしトピック固有の
// キーワード・除外ドメインは cloudflare:workers に依存しない src/config/topic.config.mjs を
// 直接 import するため、トピック設定を変更してもここを個別に直す必要はない。
//
// 実測結果（2026-07-07時点）: 「ポケモン」「ポケモン API」「pokeapi」等いずれのキーワードでも、
// はてなブックマーク検索は複数語を与えても実質AND検索にならず、Anthropic/Claude/AWS等の
// 話題性の高い無関係な最近の記事が上位に混入することを確認済み（docs/progress/2026-07-07.md）。

import { topic } from '../../src/config/topic.config.mjs';

const POKEMON_KEYWORDS = topic.collection.searchKeywords;

// src/lib/importers/keywords.ts の EXCLUDED_BLOG_DOMAINS / FILTERED_BLOG_DOMAINS。
// 先頭の共通ドメインはトピックに依らないためここでも直書きし、トピック固有分だけ config から取る。
const EXCLUDED_BLOG_DOMAINS = [
	'qiita.com', 'zenn.dev', 'note.com', 'github.com', 'youtube.com', 'x.com', 'twitter.com',
	...topic.collection.extraExcludedBlogDomains,
];
const FILTERED_BLOG_DOMAINS = ['b.hatena.ne.jp', 'pinterest.com', 'sourceforge.net', 'play.google.com', 'apps.apple.com'];

function isExcludedBlogDomain(hostname) {
	const normalized = hostname.replace(/^www\./, '');
	return [...EXCLUDED_BLOG_DOMAINS, ...FILTERED_BLOG_DOMAINS].some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

// src/lib/importers/hatena-feed.ts の parseHatenaSearchRss 相当（簡略コピー）。
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(text) {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => NAMED_ENTITIES[name]);
}

function extractTag(block, tagName) {
	const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
	if (!match) return null;
	return decodeXmlEntities(match[1]).trim();
}

function parseHatenaSearchRss(xml) {
	const entries = [];
	const itemRegex = /<item\s+rdf:about="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g;
	let match;
	while ((match = itemRegex.exec(xml)) !== null) {
		const [, rawUrl, block] = match;
		const url = decodeXmlEntities(rawUrl).trim();
		if (!url) continue;
		const title = extractTag(block, 'title') ?? extractTag(block, 'link') ?? url;
		entries.push({ url, title });
	}
	return entries;
}

async function fetchHatenaSearchRss(keyword) {
	const url = new URL('https://b.hatena.ne.jp/search/text');
	url.searchParams.set('q', keyword);
	url.searchParams.set('sort', 'recent');
	url.searchParams.set('mode', 'rss');
	const response = await fetch(url, {
		headers: { 'User-Agent': 'poke-research-hatena-importer (+https://poke-research.com)' },
	});
	if (!response.ok) {
		throw new Error(`hatena search rss failed (${response.status}): ${await response.text()}`);
	}
	return parseHatenaSearchRss(await response.text());
}

function printSection(keyword, entries) {
	const excludedCount = entries.filter((e) => isExcludedBlogDomain(new URL(e.url).hostname)).length;
	console.log(`\n=== キーワード: "${keyword}" ${entries.length}件（うち除外ドメイン ${excludedCount}件） ===`);
	entries.forEach((e, i) => {
		const hostname = new URL(e.url).hostname;
		const flag = isExcludedBlogDomain(hostname) ? ' [除外ドメイン]' : '';
		console.log(`${i + 1}. ${e.title}${flag}`);
		console.log(`   ${hostname} — ${e.url}`);
	});
}

// robots.txt (b.hatena.ne.jp/robots.txt) の Crawl-delay: 5 に従う。
const CRAWL_DELAY_MS = 5_000;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	const onlyKeyword = process.env.HATENA_EVAL_KEYWORD?.trim();
	const keywords = onlyKeyword ? [onlyKeyword] : POKEMON_KEYWORDS;

	console.log('AIレビュー・本文取得前の生のはてなブックマーク検索RSS結果（タイトル・URLのみ）。');
	console.log('ポケモンのプログラミング・開発と無関係な記事（ゴミ）がどれだけ混ざっているか、');
	console.log('除外ドメインの判定漏れがないかを、Claude Codeがこれを見て判定すること。');
	console.log(`(消費リクエスト数見込み=${keywords.length}, リクエスト間隔=${CRAWL_DELAY_MS}ms)`);

	for (let i = 0; i < keywords.length; i += 1) {
		if (i > 0) await sleep(CRAWL_DELAY_MS);
		const entries = await fetchHatenaSearchRss(keywords[i]);
		printSection(keywords[i], entries);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
