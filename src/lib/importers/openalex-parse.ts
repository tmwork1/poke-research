// OpenAlex Works API（https://api.openalex.org/works）のレスポンス（Work object）から、
// DB保存・重複判定に必要な情報を取り出す純粋関数群。arxiv-feed.ts と同じ方針で、
// cloudflare:workers に依存しないため tests/openalex-parse.test.ts で直接ユニットテストできる。
import { canonicalizeArxivAbsUrl } from './arxiv-feed.ts';

export interface OpenAlexLocation {
	landing_page_url?: string | null;
	pdf_url?: string | null;
	source?: { display_name?: string | null } | null;
}

export interface OpenAlexAuthorship {
	author?: { display_name?: string | null } | null;
}

export interface OpenAlexWork {
	id: string;
	doi?: string | null;
	title?: string | null;
	display_name?: string | null;
	type?: string | null;
	publication_date?: string | null;
	updated_date?: string | null;
	cited_by_count?: number | null;
	indexed_in?: string[] | null;
	authorships?: OpenAlexAuthorship[] | null;
	primary_location?: OpenAlexLocation | null;
	locations?: OpenAlexLocation[] | null;
	open_access?: { is_oa?: boolean | null; oa_status?: string | null } | null;
	abstract_inverted_index?: Record<string, number[]> | null;
}

const ARXIV_ABS_URL_PATTERN = /^https?:\/\/(www\.)?arxiv\.org\/abs\//i;
// arXivは2022年以降、自身の登録DOIプレフィックス（10.48550/arxiv.<arXiv ID>）を発行しており、
// OpenAlexはこのDOI経由のレコードとarxiv.org自体を発見元とするレコードを別のWork objectとして
// 保持することがある（実データ確認: "PokeRL: Reinforcement Learning for Pokemon Red"が
// doi=10.48550/arxiv.2604.10812のWorkとprimary_location=arxiv.org/abs/2604.10812のWorkの
// 2件として別々に存在）。前者はlanding_page_urlがarxiv.org/abs/形式ではないため、
// DOIの方も別途チェックしないとarxiv.ts（arXiv importer）の行と重複してしまう。
const ARXIV_DOI_PATTERN = /^https?:\/\/doi\.org\/10\.48550\/arxiv\.(.+)$/i;

// abstract_inverted_index（単語 -> 出現位置の配列）から平文のアブストラクトを復元する。
// OpenAlexは出版社の権利関係を理由に平文のアブストラクトを直接提供しないため、この形式でしか
// 得られない（docs/plan/paper.md の未確認事項と同種の論点。詳細はPR説明を参照）。
export function reconstructAbstract(invertedIndex: Record<string, number[]> | null | undefined): string {
	if (!invertedIndex) return '';
	const positions = Object.values(invertedIndex).flat();
	if (positions.length === 0) return '';

	const maxIndex = Math.max(...positions);
	const words: string[] = new Array(maxIndex + 1).fill('');
	for (const [word, wordPositions] of Object.entries(invertedIndex)) {
		for (const position of wordPositions) {
			words[position] = word;
		}
	}
	return words.join(' ').replace(/\s+/g, ' ').trim();
}

// doi・primary_location・locations を走査し、arXivのアブストラクトページに行き着ければ
// arxiv.ts（arXiv importer）と同じ正規化ルールで返す。無ければ null。
export function findArxivAbsUrl(work: Pick<OpenAlexWork, 'doi' | 'primary_location' | 'locations'>): string | null {
	if (work.doi) {
		const doiMatch = work.doi.match(ARXIV_DOI_PATTERN);
		if (doiMatch) return canonicalizeArxivAbsUrl(`https://arxiv.org/abs/${doiMatch[1]}`);
	}

	const candidateLocations = [work.primary_location, ...(work.locations ?? [])].filter(
		(location): location is OpenAlexLocation => Boolean(location),
	);
	for (const location of candidateLocations) {
		const landingPageUrl = location.landing_page_url;
		if (landingPageUrl && ARXIV_ABS_URL_PATTERN.test(landingPageUrl)) {
			return canonicalizeArxivAbsUrl(landingPageUrl);
		}
	}
	return null;
}

// items.external_url として使うURLを1つ選ぶ。arXiv由来と判定できたworkは、arXiv importer
// （arxiv.ts）が使うのと同じ正規化URLを優先して使う。これによりUNIQUE制約
// （items.external_url、migrations/002）を介して、arXiv importerと同一論文が別行として
// 重複登録されるのを防ぐ（どちらが先に収集しても同じ行に収斂する）。
// arXiv由来でなければ DOI、それも無ければ常に存在する OpenAlex ID を使う。
export function selectExternalUrl(work: Pick<OpenAlexWork, 'id' | 'doi' | 'primary_location' | 'locations'>): string {
	const arxivUrl = findArxivAbsUrl(work);
	if (arxivUrl) return arxivUrl;
	if (work.doi) return work.doi;
	return work.id;
}

export function resolveTitle(work: Pick<OpenAlexWork, 'title' | 'display_name'>): string {
	return work.title ?? work.display_name ?? '';
}

export function extractAuthors(work: Pick<OpenAlexWork, 'authorships'>): string[] {
	return (work.authorships ?? [])
		.map((authorship) => authorship.author?.display_name)
		.filter((name): name is string => Boolean(name));
}

// arXiv importer（arxiv.ts の ARXIV_KEYWORD_VARIANTS）と同種の安全策として、アクセント付き
// 表記だけは同梱する。OpenAlexの全文検索がアクセント記号を畳んで扱うかは未確認のため、
// 確認が取れるまで両表記をORで束ねる（arXiv側で判明した"pokemongo"連結語のトークン化問題は
// arXiv固有の検索インデックスの挙動のため、ここでは踏襲しない。実運用でヒット率を見て要否を判断する）。
const ACCENTED_VARIANTS: Record<string, string> = { pokemon: 'pokémon' };

// OpenAlex の filter=title_and_abstract.search:a|b|c 構文（値はパイプ区切りでOR、最大100件）
// を組み立てる。
export function buildOpenAlexFilter(keywords: string[]): string {
	const terms = keywords.flatMap((keyword) => {
		const accented = ACCENTED_VARIANTS[keyword.toLowerCase()];
		return accented ? [keyword, accented] : [keyword];
	});
	return `title_and_abstract.search:${terms.join('|')}`;
}
