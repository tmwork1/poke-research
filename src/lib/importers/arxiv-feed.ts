// arXiv API（https://export.arxiv.org/api/query）が返す Atom フィードの軽量パーサー。
// hatena-feed.ts（はてなブックマーク検索RSS）・feed-xml.ts（RSS/Atom汎用）と同じ方針で、
// 依存追加を避けるため固定的なタグ構造を正規表現で抽出する純粋関数として実装する
// （cloudflare:workers に依存しないため tests/arxiv-feed.test.ts で直接ユニットテストできる）。
//
// スキーマの前提: <feed>...<entry>...</entry>...</feed> が論文ごとに1ブロックずつ並ぶ。
// タイトル・アブストラクト（summary）は改行やインデントを含む複数行テキストのため、
// 抽出後に空白を1つに畳んで整形する。
import { decodeXmlEntities } from './hatena-feed.ts';

export interface ArxivFeedEntry {
	/** entry の <id>（例: http://arxiv.org/abs/2401.01234v1）。バージョン番号を含む。 */
	id: string;
	title: string;
	/** アブストラクト全文（空白を正規化済み）。 */
	summary: string;
	authors: string[];
	published: string | null;
	updated: string | null;
	/** <category term="..."> をすべて集めたもの（primary_category を含む）。 */
	categories: string[];
	primaryCategory: string | null;
}

function stripCData(text: string): string {
	const match = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
	return match ? match[1] : text;
}

function normalizeWhitespace(text: string): string {
	// タイトル・アブストラクトは元データの折り返しでインデント込みの改行が入っているため、
	// 検索・要約生成に不要な改行差を持ち込まないよう空白1つに畳む。
	return text.replace(/\s+/g, ' ').trim();
}

function extractTagText(block: string, tagName: string): string | null {
	// title/summary 等は属性を伴わないが、feed-xml.ts と同じ形で属性付きタグにも耐性を持たせる。
	const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`));
	if (!match) return null;
	return normalizeWhitespace(decodeXmlEntities(stripCData(match[1])));
}

function extractAuthors(block: string): string[] {
	const authors: string[] = [];
	const authorRegex = /<author>([\s\S]*?)<\/author>/g;
	let match: RegExpExecArray | null;
	while ((match = authorRegex.exec(block)) !== null) {
		const name = extractTagText(match[1], 'name');
		if (name) authors.push(name);
	}
	return authors;
}

function extractCategories(block: string): { categories: string[]; primaryCategory: string | null } {
	const categories: string[] = [];
	const categoryRegex = /<category\b([^>]*)\/?>/g;
	let match: RegExpExecArray | null;
	while ((match = categoryRegex.exec(block)) !== null) {
		const termMatch = match[1].match(/term="([^"]*)"/);
		if (termMatch) categories.push(decodeXmlEntities(termMatch[1]).trim());
	}

	const primaryMatch = block.match(/<arxiv:primary_category\b([^>]*)\/?>/);
	const primaryTermMatch = primaryMatch ? primaryMatch[1].match(/term="([^"]*)"/) : null;
	const primaryCategory = primaryTermMatch ? decodeXmlEntities(primaryTermMatch[1]).trim() : null;

	return { categories: [...new Set(categories)], primaryCategory };
}

export function parseArxivFeed(xml: string): ArxivFeedEntry[] {
	const entries: ArxivFeedEntry[] = [];
	const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
	let match: RegExpExecArray | null;

	while ((match = entryRegex.exec(xml)) !== null) {
		const block = match[1];
		const id = extractTagText(block, 'id');
		// 検索条件に一致しない／エラー時、arXiv API は id が "http://arxiv.org/api/errors#..." の
		// 単一 entry を返すことがあるため、通常の論文ページ（/abs/）だけを対象にする。
		if (!id || !id.includes('/abs/')) continue;

		const title = extractTagText(block, 'title') ?? id;
		const summary = extractTagText(block, 'summary') ?? '';
		const authors = extractAuthors(block);
		const published = extractTagText(block, 'published');
		const updated = extractTagText(block, 'updated');
		const { categories, primaryCategory } = extractCategories(block);

		entries.push({ id, title, summary, authors, published, updated, categories, primaryCategory });
	}

	return entries;
}
