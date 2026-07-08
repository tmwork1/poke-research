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
	findItemVersionByExternalUrl,
	mapWithConcurrency,
	processImportItem,
	truncateBodyForStorage,
	upsertFeedSubscription,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
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
}

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
// 検索語（POKEMON_KEYWORDS）は収集内容の質に直結するため、他インポーター同様 env では管理しない。
export function resolveHatenaSyncOptions(env: HatenaEnvDefaults, overrides: HatenaSyncOptions = {}): Required<HatenaSyncOptions> {
	return {
		keyword: overrides.keyword?.trim() || '',
		maxCandidatesPerKeyword: parsePositiveInteger(
			overrides.maxCandidatesPerKeyword,
			parsePositiveInteger(env.HATENA_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES_PER_KEYWORD),
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

async function processHatenaCandidate(candidate: HatenaCandidate, fetchedAt: string, existingTags: string[]): Promise<ImportItemOutcome> {
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

		const existingVersion = await findItemVersionByExternalUrl(externalUrl);
		if (existingVersion === bodyHash) {
			return { id: null, action: 'skipped', externalUrl, title, reason: 'unchanged since last collection' };
		}

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

				return upsertItemByExternalUrl(
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
						body: truncateBodyForStorage(extracted.bodyText),
						aiAccepted: review.accepted,
					},
					review.tags,
					review.tagLabels,
					{ syncTags: review.accepted },
				);
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
	const fetchedAt = new Date().toISOString();

	const [{ candidates, requestsUsed }, existingTags] = await Promise.all([
		discoverCandidates(keywords, maxCandidatesPerKeyword),
		fetchTopTagNames(),
	]);

	const itemResults = await mapWithConcurrency(candidates, IMPORT_CONCURRENCY, (candidate) =>
		processHatenaCandidate(candidate, fetchedAt, existingTags),
	);

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
