// はてなブックマークの検索RSS（キーワード横断・全ウェブ対象）でポケモン関連キーワードを検索し、
// 見つかった記事を blog.ts と同じ汎用 HTML 抽出（Cloudflare の HTMLRewriter）で取り込む。
// 本文抽出・AIレビュー・DB upsert・タグ同期は blog.ts の実装をそのまま再利用し、差し替えるのは
// 「候補発見（discovery）」部分のみ（Brave Search API → はてなブックマーク検索RSS）。
//
// 精度についての注記: 実地検証の結果、はてなブックマーク検索は複数キーワードを与えても実質的な
// AND検索にならず、話題性の高い無関係な最近の記事が混入しやすいことを確認した
// （docs/progress/2026-07-07.md 参照）。これは note.ts で過去に確認した「母集団の性質上の問題」と
// 同種のため、既存の2段階AIレビュー（article-ai.ts）を安全網として運用し、原始候補数だけ
// MAX_CANDIDATES_PER_KEYWORD で保守的に絞ることでOpenAIコストを抑える。
import { parsePositiveInteger } from '../params';
import { reviewImportArticle } from './article-ai';
import { extractPage, fetchCandidatePage, hashBody, resolveBlogSource, type ExtractedPage } from './blog';
import {
	fetchTopTagNames,
	findExistingExternalUrls,
	mapWithConcurrency,
	processImportItem,
	syncNewItemTagsBatch,
	truncateBodyForStorage,
	upsertFeedSubscription,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
	type ItemTagSyncEntry,
} from './common';
import { parseHatenaSearchRss } from './hatena-feed';
import { isExcludedBlogDomain, POKEMON_KEYWORDS } from './keywords';
import { topic } from '../../config/topic.config.mjs';

const DEFAULT_KIND = 'article';
const MIN_BODY_CHARS = 200;
const MAX_AI_BODY_CHARS = 4000;
const IMPORT_CONCURRENCY = 2;
const HATENA_FETCH_TIMEOUT_MS = 10_000;
const HATENA_USER_AGENT = `${topic.site.slug}-hatena-importer (+${topic.site.url})`;
const HATENA_SEARCH_RSS_URL = 'https://b.hatena.ne.jp/search/text';

// b.hatena.ne.jp/robots.txt の `Crawl-delay: 5` に従い、キーワードごとのリクエスト間隔を空ける。
const HATENA_CRAWL_DELAY_MS = 5_000;

// 新規ソースのため初期は保守的に絞る。POKEMON_KEYWORDS(6語)×15件=最大90件/日の本文取得・
// AIレビューが上限になる（blog.ts の count/pages 相当の役割）。
const DEFAULT_MAX_CANDIDATES_PER_KEYWORD = 15;

export interface HatenaSyncOptions {
	keyword?: string;
	maxCandidatesPerKeyword?: number;
	maxNewItemsPerRun?: number;
}

export interface HatenaSyncResult {
	keywords: string[];
	maxCandidatesPerKeyword: number;
	requestsUsed: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

export interface HatenaEnvDefaults {
	HATENA_MAX_CANDIDATES?: string | number;
	HATENA_MAX_NEW_PER_RUN?: string | number;
}

// 発見段階（キーワードごとの検索RSS取得等）の固定コストに加え、新規記事1件あたり本文取得＋
// 既存チェック（assumeNew非対応）＋OpenAIレビュー＋item upsertの計4 subrequestsがかかる
// （common.tsの構造から確定。他ジョブと異なりassumeNewを使っていないため既存チェックのselect
// が残る）。固定コスト（新規0件時）は2026-07-09の実測で39だったが、コードから見積もる素朴な
// 理論値（検索RSS取得6回＋既存URL一括チェック1回＋タグ上位取得1回≒9件程度）とは大きな乖離が
// あり、原因は未解明（要調査）。他ジョブより固定コストの実測値が大きいため、件数は控えめにする
// （詳細はdocs/issue/cron-subrequest-limit.md参照）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 6;

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
// 検索語（POKEMON_KEYWORDS）は収集内容の質に直結するため、他インポーター同様 env では管理しない。
export function resolveHatenaSyncOptions(env: HatenaEnvDefaults, overrides: HatenaSyncOptions = {}): Required<HatenaSyncOptions> {
	return {
		keyword: overrides.keyword?.trim() || '',
		maxCandidatesPerKeyword: parsePositiveInteger(
			overrides.maxCandidatesPerKeyword,
			parsePositiveInteger(env.HATENA_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES_PER_KEYWORD),
		),
		// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数に
		// 上限を設ける。超過分は次回実行に持ち越される（既存URL判定に残るため記事が失われることはない）。
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.HATENA_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function isExcludedDomain(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return true;
	}
	// 判定（EXCLUDED_BLOG_DOMAINS + FILTERED_BLOG_DOMAINS）は keywords.ts に委譲する。
	// qiita/zenn/note等、専用インポーターが既に扱うドメインはここで重複収集を避ける。
	return isExcludedBlogDomain(hostname);
}

interface HatenaCandidate {
	url: string;
	title: string;
	date: string | null;
	keyword: string;
}

interface DiscoverResult {
	candidates: HatenaCandidate[];
	requestsUsed: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHatenaSearchRss(keyword: string): Promise<ReturnType<typeof parseHatenaSearchRss>> {
	const url = new URL(HATENA_SEARCH_RSS_URL);
	url.searchParams.set('q', keyword);
	url.searchParams.set('sort', 'recent');
	url.searchParams.set('mode', 'rss');

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HATENA_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { 'User-Agent': HATENA_USER_AGENT },
		});
		if (!response.ok) {
			throw new Error(`hatena search rss failed (${response.status})`);
		}
		return parseHatenaSearchRss(await response.text());
	} finally {
		clearTimeout(timeout);
	}
}

async function discoverCandidates(keywords: string[], maxCandidatesPerKeyword: number): Promise<DiscoverResult> {
	// 複数キーワードで見つかった同一URLは1件だけ残す。
	const candidates: HatenaCandidate[] = [];
	const seen = new Set<string>();
	let requestsUsed = 0;

	for (const keyword of keywords) {
		// robots.txt の Crawl-delay: 5 に従い、初回以外はリクエスト前に待機する。
		if (requestsUsed > 0) await sleep(HATENA_CRAWL_DELAY_MS);

		const entries = await fetchHatenaSearchRss(keyword);
		requestsUsed += 1;

		let addedForKeyword = 0;
		for (const entry of entries) {
			if (addedForKeyword >= maxCandidatesPerKeyword) break;
			if (seen.has(entry.url) || isExcludedDomain(entry.url)) continue;
			seen.add(entry.url);
			candidates.push({ url: entry.url, title: entry.title, date: entry.date, keyword });
			addedForKeyword += 1;
		}
	}

	return { candidates, requestsUsed };
}

function createSourceMetadata(keyword: string, fetchedAt: string) {
	return {
		service: 'blog',
		discovery: 'hatena-bookmark-search',
		collection: { keyword, fetched_at: fetchedAt },
	};
}

function createItemMetadata(
	extracted: ExtractedPage,
	hostname: string,
	candidate: HatenaCandidate,
	fetchedAt: string,
	review: Awaited<ReturnType<typeof reviewImportArticle>>,
) {
	return {
		service: 'blog',
		blog: {
			hostname,
			canonical_url: extracted.canonicalUrl,
			site_name: extracted.ogSiteName,
			extraction_method: extracted.extractionMethod,
		},
		provenance: {
			source: 'hatena-bookmark-importer',
			keyword: candidate.keyword,
			fetched_at: fetchedAt,
			hatena_bookmarked_at: candidate.date,
		},
		ai: {
			model: review.model,
			accepted: review.accepted,
			reason: review.reason,
			confidence: review.confidence ?? null,
			summary: review.summary,
			tags: review.tags,
		},
	};
}

async function processHatenaCandidate(
	candidate: HatenaCandidate,
	fetchedAt: string,
	existingTags: string[],
	pendingTagEntries: ItemTagSyncEntry[],
): Promise<ImportItemOutcome> {
	// 記事単位の失敗（fetch失敗、非HTML、抽出不足など）はここで吸収し、バッチ全体を止めない。
	try {
		const response = await fetchCandidatePage(candidate.url, HATENA_USER_AGENT);
		if (!response.ok) {
			return { id: null, action: 'skipped', externalUrl: candidate.url, title: candidate.title, reason: `fetch failed (${response.status})` };
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('text/html')) {
			return { id: null, action: 'skipped', externalUrl: candidate.url, title: candidate.title, reason: 'non-html content' };
		}

		const extracted = await extractPage(response);
		if (extracted.bodyText.length < MIN_BODY_CHARS) {
			return { id: null, action: 'skipped', externalUrl: candidate.url, title: extracted.title ?? candidate.title, reason: 'body too short to review' };
		}

		const externalUrl = extracted.canonicalUrl || response.url || candidate.url;
		const title = extracted.title || candidate.title;
		const authors = extracted.author ? [extracted.author] : [];
		const bodyHash = await hashBody(extracted.bodyText);

		const hostname = new URL(externalUrl).hostname;
		const aiBodyExcerpt = extracted.bodyText.length > MAX_AI_BODY_CHARS ? extracted.bodyText.slice(0, MAX_AI_BODY_CHARS) : extracted.bodyText;

		return await processImportItem(
			externalUrl,
			title,
			() =>
				reviewImportArticle({
					sourceName: extracted.ogSiteName || hostname,
					query: candidate.keyword,
					title,
					url: externalUrl,
					authors,
					sourceTags: [],
					existingTags,
					createdAt: extracted.publishedAt ?? candidate.date ?? undefined,
					updatedAt: extracted.modifiedAt ?? undefined,
					bodyExcerpt: aiBodyExcerpt,
				}),
			async (review) => {
				// blog.ts と同様、採用された記事のページがRSS/Atomフィードを配信していれば登録し、
				// 以後 feed.ts が直接ポーリングできるようにする。
				if (review.accepted && extracted.feedUrl) {
					await upsertFeedSubscription({ feedUrl: extracted.feedUrl, hostname, discoveredFromUrl: externalUrl });
				}

				const blogSource = resolveBlogSource(hostname);
				const source = await upsertSourceByOriginUrl({
					name: blogSource.name,
					type: 'blog',
					originUrl: blogSource.originUrl,
					metadata: createSourceMetadata(candidate.keyword, fetchedAt),
				});

				const result = await upsertItemByExternalUrl(
					{
						sourceId: source.id,
						externalUrl,
						kind: DEFAULT_KIND,
						title,
						authors,
						summary: review.summary,
						publishedAt: extracted.publishedAt ?? candidate.date,
						updatedAt: extracted.modifiedAt,
						metadata: createItemMetadata(extracted, hostname, candidate, fetchedAt, review),
						version: bodyHash,
						collectionRoute: 'hatena-bookmark-importer',
						body: truncateBodyForStorage(extracted.bodyText),
						aiAccepted: review.accepted,
						language: review.language,
					},
					review.tags,
					review.tagLabels,
					// タグ同期はここでは行わず（syncTags: false）、呼び出し元でまとめて行う。
					{ syncTags: false },
				);
				if (review.accepted) pendingTagEntries.push({ itemId: result.id, tags: review.tags, tagLabels: review.tagLabels });
				return result;
			},
		);
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl: candidate.url,
			title: candidate.title,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}

export async function syncHatenaCollection(options: HatenaSyncOptions = {}): Promise<HatenaSyncResult> {
	const keywords = options.keyword?.trim() ? [options.keyword.trim()] : [...POKEMON_KEYWORDS];
	const maxCandidatesPerKeyword = parsePositiveInteger(options.maxCandidatesPerKeyword, DEFAULT_MAX_CANDIDATES_PER_KEYWORD);
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const fetchedAt = new Date().toISOString();

	const [{ candidates, requestsUsed }, existingTags] = await Promise.all([
		discoverCandidates(keywords, maxCandidatesPerKeyword),
		fetchTopTagNames(),
	]);

	// 既に収集済みのURLは、本文取得・AIレビューを行わずスキップする（記事内容の変更は追跡しない
	// 方針のため、判定はURLの既存有無のみ。cronのsubrequest数・外部fetch回数を抑える）。
	const existingUrls = await findExistingExternalUrls(candidates.map((candidate) => candidate.url));
	const newCandidates = candidates.filter((candidate) => !existingUrls.has(candidate.url));

	// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数を
	// maxNewItemsPerRun件までに絞る。超過分は本文取得自体を省略してスキップし、次回実行時に
	// 既存URL判定に引っかからず自然に再度候補となる（記事が失われるわけではない）。
	const candidatesToProcess = newCandidates.slice(0, maxNewItemsPerRun);
	const deferredCandidates = newCandidates.slice(maxNewItemsPerRun);

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const processedResults = await mapWithConcurrency(candidatesToProcess, IMPORT_CONCURRENCY, (candidate) =>
		processHatenaCandidate(candidate, fetchedAt, existingTags, pendingTagEntries),
	);
	await syncNewItemTagsBatch(pendingTagEntries);
	const skippedKnownResults: ImportItemOutcome[] = candidates
		.filter((candidate) => existingUrls.has(candidate.url))
		.map((candidate) => ({ id: null, action: 'skipped', externalUrl: candidate.url, title: candidate.title, reason: 'already collected' }));
	const deferredResults: ImportItemOutcome[] = deferredCandidates.map((candidate) => ({
		id: null,
		action: 'skipped',
		externalUrl: candidate.url,
		title: candidate.title,
		reason: 'exceeded max new items per run',
	}));
	const itemResults = [...processedResults, ...skippedKnownResults, ...deferredResults];

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	for (const result of itemResults) {
		if (result.action === 'inserted') inserted += 1;
		else if (result.action === 'updated') updated += 1;
		else skipped += 1;
	}

	return {
		keywords,
		maxCandidatesPerKeyword,
		requestsUsed,
		fetched: candidates.length,
		inserted,
		updated,
		skipped,
		fetchedAt,
		items: itemResults,
	};
}
