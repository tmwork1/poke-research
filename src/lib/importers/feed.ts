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
	maxNewItemsPerRun?: number;
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
	FEED_MAX_NEW_PER_RUN?: string | number;
}

// 購読フィード数（blog/hatenaの記事採用時に自動登録され、今後も増え続ける）に比例する
// 発見段階の固定コストに加え、新規記事1件あたりfetch＋既存チェック（assumeNew非対応）＋
// OpenAIレビュー＋item upsertの計4 subrequestsを2026-07-09に実測で確認した。固定コスト
// （新規0件時）は実測21で、新規記事が1件以上あるときだけ発生するタグ同期バッチの初回コスト
// （2件程度）を合わせると、上限50/呼び出しに収まる新規件数は (50-21-2)/4 ≒ 6.7 件までとなる。
// 旧値の10件では最大約63 subrequestsとなり上限を超えうることが判明したため、
// 安全マージンを見て6件に引き下げた（詳細はdocs/issue/cron-subrequest-limit.md参照）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 6;

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
export function resolveFeedSyncOptions(env: FeedEnvDefaults, overrides: FeedSyncOptions = {}): Required<FeedSyncOptions> {
	return {
		maxEntriesPerFeed: parsePositiveInteger(
			overrides.maxEntriesPerFeed,
			parsePositiveInteger(env.FEED_MAX_ENTRIES, DEFAULT_MAX_ENTRIES_PER_FEED),
		),
		// 新着記事が急増した日（購読フィードのバックログ発生時等）でも1回の実行でsubrequest上限を
		// 超えないよう、実際に処理する新規件数に上限を設ける。超過分は次回実行に持ち越される
		// （既存URL判定に残るため記事が失われることはない）。
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.FEED_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
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
			prompt_version: review.promptVersion,
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
						collectionRoute: 'feed-importer',
						body: truncateBodyForStorage(extracted.bodyText),
						aiAccepted: review.accepted,
						language: review.language,
						aiReviewModel: review.model,
						aiReviewPromptVersion: review.promptVersion,
						aiReviewReason: review.reason,
						aiReviewConfidence: review.confidence ?? null,
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
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const fetchedAt = new Date().toISOString();

	const [subscriptions, existingTags] = await Promise.all([fetchActiveFeedSubscriptions(), fetchTopTagNames()]);

	const { candidates, feedsPolled, requestsUsed } = await discoverCandidates(subscriptions, maxEntriesPerFeed);

	// discoverCandidatesが返す候補は既に「新規（未収集）」のみだが、購読フィードのバックログや
	// 購読数の増加で件数が急増しても1回の実行でsubrequest上限を超えないよう、実際に処理する件数を
	// maxNewItemsPerRun件までに絞る。超過分は本文取得自体を省略してスキップし、次回実行時に
	// 既存URL判定に引っかからず自然に再度候補となる（記事が失われるわけではない）。
	const candidatesToProcess = candidates.slice(0, maxNewItemsPerRun);
	const deferredCandidates = candidates.slice(maxNewItemsPerRun);

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const processedResults = await mapWithConcurrency(candidatesToProcess, IMPORT_CONCURRENCY, (candidate) =>
		processFeedCandidate(candidate, fetchedAt, existingTags, pendingTagEntries),
	);
	await syncNewItemTagsBatch(pendingTagEntries);
	const deferredResults: ImportItemOutcome[] = deferredCandidates.map((candidate) => ({
		id: null,
		action: 'skipped',
		externalUrl: candidate.url,
		title: candidate.title,
		reason: 'exceeded max new items per run',
	}));
	const itemResults = [...processedResults, ...deferredResults];

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
