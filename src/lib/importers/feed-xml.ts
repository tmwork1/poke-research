// RSS 2.0 / Atom フィードの軽量パーサー。note.com・WordPress系・はてなブログなどが配信する
// 個別ブログの `/rss` `/feed` エンドポイントはこの2形式のいずれかであるため、それだけをカバーする。
// hatena-feed.ts（はてなブックマーク検索RSS、RSS 1.0/RDF）と同じ方針で、依存追加を避けるため
// 固定的なタグ構造を正規表現で抽出する純粋関数として実装する（cloudflare:workers に依存しないため
// tests/feed-xml.test.ts で直接ユニットテストできる）。
import { decodeXmlEntities } from './hatena-feed.ts';

export interface FeedEntry {
	url: string;
	title: string;
	date: string | null;
}

function stripCData(text: string): string {
	const match = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
	return match ? match[1] : text;
}

function extractTagText(block: string, tagName: string): string | null {
	// title/pubDate 等は属性を伴う場合がある（例: <title type="html">）ため、開始タグの属性は無視する。
	const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`));
	if (!match) return null;
	return decodeXmlEntities(stripCData(match[1])).trim();
}

function extractAtomLink(block: string): string | null {
	// Atom の <link> は自己終了タグで href 属性に URL を持ち、rel="alternate"（既定）/"self" 等が
	// 複数並びうる。記事本体を指す alternate を優先し、無ければ最初に見つかった href にフォールバックする。
	const linkRegex = /<link\b([^>]*)\/?>/g;
	let match: RegExpExecArray | null;
	let fallback: string | null = null;
	while ((match = linkRegex.exec(block)) !== null) {
		const attrs = match[1];
		const hrefMatch = attrs.match(/href="([^"]*)"/);
		if (!hrefMatch) continue;
		const relMatch = attrs.match(/rel="([^"]*)"/);
		const rel = relMatch ? relMatch[1] : 'alternate';
		const href = decodeXmlEntities(hrefMatch[1]).trim();
		if (rel === 'alternate') return href;
		if (!fallback) fallback = href;
	}
	return fallback;
}

export function parseRssEntries(xml: string): FeedEntry[] {
	const entries: FeedEntry[] = [];
	const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
	let match: RegExpExecArray | null;

	while ((match = itemRegex.exec(xml)) !== null) {
		const block = match[1];
		const url = extractTagText(block, 'link');
		if (!url) continue;

		const title = extractTagText(block, 'title') ?? url;
		const date = extractTagText(block, 'pubDate') ?? extractTagText(block, 'dc:date');
		entries.push({ url, title, date });
	}

	return entries;
}

export function parseAtomEntries(xml: string): FeedEntry[] {
	const entries: FeedEntry[] = [];
	const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
	let match: RegExpExecArray | null;

	while ((match = entryRegex.exec(xml)) !== null) {
		const block = match[1];
		const url = extractAtomLink(block);
		if (!url) continue;

		const title = extractTagText(block, 'title') ?? url;
		const date = extractTagText(block, 'updated') ?? extractTagText(block, 'published');
		entries.push({ url, title, date });
	}

	return entries;
}

export function parseFeed(xml: string): FeedEntry[] {
	// RSS 2.0 は <item>、Atom は <entry> がエントリの単位で、フィードは通常どちらか一方のみを含む。
	const rssEntries = parseRssEntries(xml);
	if (rssEntries.length > 0) return rssEntries;
	return parseAtomEntries(xml);
}
