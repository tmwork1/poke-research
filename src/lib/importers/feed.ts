// feed_subscriptions（migrations/022）に登録済みの RSS/Atom フィードを直接ポーリングして記事を
// 取り込む。登録自体は blog.ts / hatena.ts が、AIレビューで採用された記事のページに
// <link rel="alternate" type="application/rss+xml|atom+xml"> を見つけた際に行う（本ファイルでは
// 発見済みフィードの追従のみを担当する）。
//
// 「発見はBrave Search/はてなブックマーク検索、追従はRSS」と役割を分けることで、既に良質だと
// わかっている発信元をキーワード検索で毎回探し直さずに済み、Brave無料枠の消費と誤検出を減らす。
// 本文抽出・AIレビュー・DB upsertは blog.ts の実装をそのまま再利用する。
import { parsePositiveInteger } from '../params';
import { reviewImportArticle } from './article-ai';
import { extractPage, fetchCandidatePage, hashBody, resolveBlogSource, type ExtractedPage } from './blog';
import {
	fetchActiveFeedSubscriptions,
	fetchTopTagNames,
	findExistingExternalUrls,
	mapWithConcurrency,
	processImportItem,
	recordFeedFetchOutcome,
	syncNewItemTagsBatch,
	truncateBodyForStorage,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type FeedSubscription,
	type ImportItemOutcome,
	type ItemTagSyncEntry,
} from './common';
import { parseFeed } from './feed-xml';
import { topic } from '../../config/topic.config.mjs';

const DEFAULT_KIND = 'article';
const MIN_BODY_CHARS = 200;
const MAX_AI_BODY_CHARS = 4000;
const IMPORT_CONCURRENCY = 2;
const FEED_FETCH_TIMEOUT_MS = 10_000;
const FEED_USER_AGENT = `${topic.site.slug}-feed-importer (+${topic.site.url})`;

// 1フィードあたりの新規記事取得上限。フィードが過去記事を大量に含んでいても、本文取得・
// AIレビューのコストを抑えるためこの件数で打ち切る（新着順で配信される前提）。
const DEFAULT_MAX_ENTRIES_PER_FEED = 10;

export interface FeedSyncOptions {
	maxEntriesPerFeed?: number;
}

export interface FeedSyncResult {
	feedsPolled: number;
	maxEntriesPerFeed: number;
	requestsUsed: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

export interface FeedEnvDefaults {
	FEED_MAX_ENTRIES?: string | number;
}

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
export function resolveFeedSyncOptions(env: FeedEnvDefaults, overrides: FeedSyncOptions = {}): Required<FeedSyncOptions> {
	return {
		maxEntriesPerFeed: parsePositiveInteger(
			overrides.maxEntriesPerFeed,
			parsePositiveInteger(env.FEED_MAX_ENTRIES, DEFAULT_MAX_ENTRIES_PER_FEED),
		),
	};
}

interface FeedCandidate {
	url: string;
	title: string;
	date: string | null;
	feedUrl: string;
}

interface DiscoverResult {
	candidates: FeedCandidate[];
	feedsPolled: number;
	requestsUsed: number;
}

async function fetchFeedXml(feedUrl: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(feedUrl, {
			signal: controller.signal,
			headers: { 'User-Agent': FEED_USER_AGENT },
		});
		if (!response.ok) {
			throw new Error(`feed fetch failed (${response.status})`);
		}
		return await response.text();
	} finally {
		clearTimeout(timeout);
	}
}

async function discoverCandidates(subscriptions: FeedSubscription[], maxEntriesPerFeed: number): Promise<DiscoverResult> {
	const candidates: FeedCandidate[] = [];
	let requestsUsed = 0;

	for (const subscription of subscriptions) {
		let entries: ReturnType<typeof parseFeed>;
		try {
			const xml = await fetchFeedXml(subscription.feedUrl);
			requestsUsed += 1;
			entries = parseFeed(xml);
		} catch {
			await recordFeedFetchOutcome(subscription.id, false);
			continue;
		}

		await recordFeedFetchOutcome(subscription.id, true);

		const limited = entries.slice(0, maxEntriesPerFeed);
		if (limited.length === 0) continue;

		// フィード自体の取得は成功しても、記事単位のURLが既知（取り込み済み）なら本文取得・
		// AIレビューまでは行わずスキップし、コストを抑える。
		const existingUrls = await findExistingExternalUrls(limited.map((entry) => entry.url));
		for (const entry of limited) {
			if (existingUrls.has(entry.url)) continue;
			candidates.push({ url: entry.url, title: entry.title, date: entry.date, feedUrl: subscription.feedUrl });
		}
	}

	return { candidates, feedsPolled: subscriptions.length, requestsUsed };
}

function createSourceMetadata(feedUrl: string, fetchedAt: string) {
	return {
		service: 'blog',
		discovery: 'rss-feed',
		collection: { feed_url: feedUrl, fetched_at: fetchedAt },
	};
}

function createItemMetadata(
	extracted: ExtractedPage,
	hostname: string,
	candidate: FeedCandidate,
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
			source: 'feed-importer',
			feed_url: candidate.feedUrl,
			fetched_at: fetchedAt,
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

async function processFeedCandidate(
	candidate: FeedCandidate,
	fetchedAt: string,
	existingTags: string[],
	pendingTagEntries: ItemTagSyncEntry[],
): Promise<ImportItemOutcome> {
	// 記事単位の失敗（fetch失敗、非HTML、抽出不足など）はここで吸収し、バッチ全体を止めない。
	try {
		const response = await fetchCandidatePage(candidate.url, FEED_USER_AGENT);
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
					query: candidate.feedUrl,
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
				const blogSource = resolveBlogSource(hostname);
				const source = await upsertSourceByOriginUrl({
					name: blogSource.name,
					type: 'blog',
					originUrl: blogSource.originUrl,
					metadata: createSourceMetadata(candidate.feedUrl, fetchedAt),
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

export async function syncFeedCollection(options: FeedSyncOptions = {}): Promise<FeedSyncResult> {
	const maxEntriesPerFeed = parsePositiveInteger(options.maxEntriesPerFeed, DEFAULT_MAX_ENTRIES_PER_FEED);
	const fetchedAt = new Date().toISOString();

	const [subscriptions, existingTags] = await Promise.all([fetchActiveFeedSubscriptions(), fetchTopTagNames()]);

	const { candidates, feedsPolled, requestsUsed } = await discoverCandidates(subscriptions, maxEntriesPerFeed);

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const itemResults = await mapWithConcurrency(candidates, IMPORT_CONCURRENCY, (candidate) =>
		processFeedCandidate(candidate, fetchedAt, existingTags, pendingTagEntries),
	);
	await syncNewItemTagsBatch(pendingTagEntries);

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	for (const result of itemResults) {
		if (result.action === 'inserted') inserted += 1;
		else if (result.action === 'updated') updated += 1;
		else skipped += 1;
	}

	return {
		feedsPolled,
		maxEntriesPerFeed,
		requestsUsed,
		fetched: candidates.length,
		inserted,
		updated,
		skipped,
		fetchedAt,
		items: itemResults,
	};
}
