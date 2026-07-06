// はてなブックマーク検索RSS（RDF/RSS 1.0）の軽量パーサー。
// 依存追加を避けるため、固定的なタグ構造を正規表現で抽出する純粋関数として実装する
// （cloudflare:workers に依存しないため tests/hatena-feed.test.ts で直接ユニットテストできる）。
// スキーマの前提: <item rdf:about="URL"><title>...</title><link>...</link>...</item> が
// 記事ごとに1ブロックずつ並ぶ（RSS 1.0 RDF形式）。<items><rdf:Seq>...</rdf:Seq></items> は
// 参照リストのみで本文を持たないため、`<item ` (属性を伴う開始タグ) だけを対象にして除外する。

export interface HatenaFeedEntry {
	url: string;
	title: string;
	date: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

export function decodeXmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => NAMED_ENTITIES[name]);
}

function extractTag(block: string, tagName: string): string | null {
	const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
	if (!match) return null;
	return decodeXmlEntities(match[1]).trim();
}

export function parseHatenaSearchRss(xml: string): HatenaFeedEntry[] {
	const entries: HatenaFeedEntry[] = [];
	const itemRegex = /<item\s+rdf:about="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g;
	let match: RegExpExecArray | null;

	while ((match = itemRegex.exec(xml)) !== null) {
		const [, rawUrl, block] = match;
		const url = decodeXmlEntities(rawUrl).trim();
		if (!url) continue;

		const title = extractTag(block, 'title') ?? extractTag(block, 'link') ?? url;
		const date = extractTag(block, 'dc:date');

		entries.push({ url, title, date });
	}

	return entries;
}
