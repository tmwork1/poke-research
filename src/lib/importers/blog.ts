// Brave Search API でポケモン関連キーワードを検索し、見つかった個人ブログ・テックブログ記事を
// 汎用的な HTML 抽出（Cloudflare の HTMLRewriter）で取り込む。Qiita/Zenn/note と異なり対象サイトが
// 都度変わるため、source はサービス単位ではなくドメイン単位で upsert する。
import { braveWebSearch, type BraveWebResult } from '../brave';
import { parseOptionalPositiveInteger, parsePositiveInteger } from '../params';
import { reviewImportArticle } from './article-ai';
import {
	fetchTopTagNames,
	findItemVersionByExternalUrl,
	mapWithConcurrency,
	processImportItem,
	truncateBodyForStorage,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
} from './common';
import { EXCLUDED_BLOG_DOMAINS, isExcludedBlogDomain, KNOWN_BLOG_PLATFORMS, OTHER_BLOG_SOURCE, POKEMON_KEYWORDS } from './keywords';
import { topic } from '../../config/topic.config.mjs';

const DEFAULT_KIND = 'article';
const MIN_BODY_CHARS = 200;
const MAX_AI_BODY_CHARS = 4000;
const IMPORT_CONCURRENCY = 2;
const FETCH_TIMEOUT_MS = 10_000;
const BLOG_USER_AGENT = `${topic.site.slug}-blog-importer (+${topic.site.url})`;

const EXCLUDED_TEXT_TAGS = 'nav, header, footer, aside, script, style';

// FETCH_TIMEOUT_MS・BLOG_USER_AGENT を含め、本文抽出・取得まわりは hatena.ts（はてなブックマーク
// 検索経由の発見）とも共有する。両者とも「発見したURLからHTMLを取得し本文を抽出する」処理は
// 同一であり、発見方法（Brave Search / はてなブックマーク検索RSS）だけが異なるため。

export interface BlogSyncOptions {
	query?: string;
	count?: number;
	offset?: number;
	pages?: number;
}

export interface BlogSyncResult {
	queries: string[];
	count: number;
	offset: number;
	pages: number;
	requestsUsed: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
// 検索語（POKEMON_KEYWORDS）は収集内容の質に直結するため、env では管理せずコードに一本化する。
export interface BlogEnvDefaults {
	BRAVE_COUNT?: string | number;
	BLOG_PAGES?: string | number;
}

// Brave Search の無料枠は月1000件（≒1日30件）が上限。cron は1日1回のため、
// 既定は「クエリ数(POKEMON_KEYWORDS=6) × pages ≒ 30件/日」に収まるよう pages=5 とする。
// また Brave の offset は「ページ番号」で最大9（=10ページ目まで）という API 制約がある。
const DEFAULT_PAGES = 5;
const BRAVE_MAX_PAGE_OFFSET = 9;

export function resolveBlogSyncOptions(env: BlogEnvDefaults, overrides: BlogSyncOptions = {}): Required<BlogSyncOptions> {
	return {
		query: overrides.query?.trim() || '',
		count: parsePositiveInteger(overrides.count, parsePositiveInteger(env.BRAVE_COUNT, 20)),
		offset: parseOptionalPositiveInteger(overrides.offset) ?? 0,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.BLOG_PAGES, DEFAULT_PAGES)),
	};
}

function buildSearchQuery(keyword: string): string {
	const exclusions = EXCLUDED_BLOG_DOMAINS.map((domain) => `-site:${domain}`).join(' ');
	return `${keyword} ${exclusions}`;
}

function isExcludedDomain(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return true;
	}
	// 実際の判定（EXCLUDED_BLOG_DOMAINS + FILTERED_BLOG_DOMAINS）は keywords.ts の
	// isExcludedBlogDomain に委譲する。cloudflare:workers 非依存の純粋関数として
	// そちらでユニットテストする。
	return isExcludedBlogDomain(hostname);
}

// 有名どころのブログサービスはユーザーごとのサブドメインをまとめてサービス単位の source にし、
// それ以外は共通の「その他」source にまとめる（ドメインごとに source が無限に増えるのを防ぐ）。
export function resolveBlogSource(hostname: string): { name: string; originUrl: string } {
	const platform = KNOWN_BLOG_PLATFORMS.find((p) => hostname === p.domain || hostname.endsWith(`.${p.domain}`));
	if (platform) return { name: platform.name, originUrl: `https://${platform.domain}/` };
	return { name: OTHER_BLOG_SOURCE.name, originUrl: OTHER_BLOG_SOURCE.originUrl };
}

interface BlogCandidate {
	url: string;
	title: string;
	age: string | null;
	rank: number;
	query: string;
}

interface DiscoverResult {
	candidates: BlogCandidate[];
	requestsUsed: number;
}

async function discoverCandidates(queries: string[], count: number, offset: number, pages: number): Promise<DiscoverResult> {
	// 複数キーワードで見つかった同一URLは1件だけ残す。除外ドメインは -site: に加えて、
	// Brave が完全には遵守しないケースに備えてここでも除く（defense in depth）。
	// pages はキーワードごとのページ送り回数（= Brave への実リクエスト数）。無料枠の消費を
	// 抑えるため、そのページの結果が count 件に満たなければ最終ページとみなして打ち切る。
	const candidates: BlogCandidate[] = [];
	const seen = new Set<string>();
	let requestsUsed = 0;
	let rank = 0;

	for (const keyword of queries) {
		for (let page = 0; page < pages; page += 1) {
			// Brave の offset は「結果件数」ではなく「ページ番号」（0〜9）。範囲外を要求すると
			// 422 が返りジョブ全体が落ちるため、上限に達したらそのキーワードは打ち切る。
			const pageOffset = offset + page;
			if (pageOffset > BRAVE_MAX_PAGE_OFFSET) break;
			const results: BraveWebResult[] = await braveWebSearch(buildSearchQuery(keyword), { count, offset: pageOffset });
			requestsUsed += 1;

			for (const result of results) {
				if (isExcludedDomain(result.url) || seen.has(result.url)) continue;
				seen.add(result.url);
				candidates.push({
					url: result.url,
					title: result.title,
					age: result.page_age ?? result.age ?? null,
					rank: rank++,
					query: keyword,
				});
			}

			if (results.length < count) break;
		}
	}

	return { candidates, requestsUsed };
}

export interface ExtractedPage {
	title: string | null;
	ogSiteName: string | null;
	canonicalUrl: string | null;
	author: string | null;
	publishedAt: string | null;
	modifiedAt: string | null;
	bodyText: string;
	extractionMethod: 'article' | 'main' | 'body';
}

function normalizeExtractedText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export async function extractPage(response: Response): Promise<ExtractedPage> {
	let ogTitle = '';
	let titleTagText = '';
	let ogSiteName = '';
	let canonicalUrl = '';
	let author = '';
	let publishedTime = '';
	let modifiedTime = '';

	let articleText = '';
	let mainText = '';
	let bodyText = '';
	let excludedDepth = 0;

	const rewriter = new HTMLRewriter()
		.on('meta[property="og:title"]', {
			element(el) {
				ogTitle = el.getAttribute('content')?.trim() || ogTitle;
			},
		})
		.on('title', {
			text(chunk) {
				titleTagText += chunk.text;
			},
		})
		.on('meta[property="og:site_name"]', {
			element(el) {
				ogSiteName = el.getAttribute('content')?.trim() || ogSiteName;
			},
		})
		.on('link[rel="canonical"]', {
			element(el) {
				canonicalUrl = el.getAttribute('href')?.trim() || canonicalUrl;
			},
		})
		.on('meta[name="author"]', {
			element(el) {
				author = el.getAttribute('content')?.trim() || author;
			},
		})
		.on('meta[property="article:published_time"]', {
			element(el) {
				publishedTime = el.getAttribute('content')?.trim() || publishedTime;
			},
		})
		.on('meta[property="article:modified_time"]', {
			element(el) {
				modifiedTime = el.getAttribute('content')?.trim() || modifiedTime;
			},
		})
		.on('article', {
			text(chunk) {
				articleText += chunk.text;
			},
		})
		.on('main', {
			text(chunk) {
				mainText += chunk.text;
			},
		})
		.on(EXCLUDED_TEXT_TAGS, {
			element(el) {
				excludedDepth += 1;
				el.onEndTag(() => {
					excludedDepth = Math.max(0, excludedDepth - 1);
				});
			},
		})
		.on('body', {
			text(chunk) {
				if (excludedDepth === 0) bodyText += chunk.text;
			},
		})
		.on('body *', {
			text(chunk) {
				if (excludedDepth === 0) bodyText += chunk.text;
			},
		});

	// HTMLRewriter はストリーム変換なので、実際にボディを読み切るまでハンドラは呼ばれない。
	await rewriter.transform(response).text();

	const normalizedArticle = normalizeExtractedText(articleText);
	const normalizedMain = normalizeExtractedText(mainText);
	const normalizedBody = normalizeExtractedText(bodyText);

	let extractionMethod: ExtractedPage['extractionMethod'] = 'body';
	let selectedBody = normalizedBody;
	if (normalizedArticle.length > 0) {
		extractionMethod = 'article';
		selectedBody = normalizedArticle;
	} else if (normalizedMain.length > 0) {
		extractionMethod = 'main';
		selectedBody = normalizedMain;
	}

	return {
		title: ogTitle || normalizeExtractedText(titleTagText) || null,
		ogSiteName: ogSiteName || null,
		canonicalUrl: canonicalUrl || null,
		author: author || null,
		publishedAt: publishedTime || null,
		modifiedAt: modifiedTime || null,
		bodyText: selectedBody,
		extractionMethod,
	};
}

export async function hashBody(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function fetchCandidatePage(url: string, userAgent: string = BLOG_USER_AGENT): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, {
			signal: controller.signal,
			headers: { 'User-Agent': userAgent },
		});
	} finally {
		clearTimeout(timeout);
	}
}

function createSourceMetadata(query: string, fetchedAt: string) {
	return {
		service: 'blog',
		discovery: 'brave-search',
		collection: { query, fetched_at: fetchedAt },
	};
}

function createItemMetadata(
	extracted: ExtractedPage,
	hostname: string,
	candidate: BlogCandidate,
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
			source: 'brave-search-importer',
			query: candidate.query,
			fetched_at: fetchedAt,
			brave_rank: candidate.rank,
			brave_age: candidate.age,
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

async function processBlogCandidate(candidate: BlogCandidate, fetchedAt: string, existingTags: string[]): Promise<ImportItemOutcome> {
	// 記事単位の失敗（fetch失敗、非HTML、抽出不足など）はここで吸収し、バッチ全体を止めない。
	try {
		const response = await fetchCandidatePage(candidate.url);
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
					query: candidate.query,
					title,
					url: externalUrl,
					authors,
					sourceTags: [],
					existingTags,
					createdAt: extracted.publishedAt ?? undefined,
					updatedAt: extracted.modifiedAt ?? undefined,
					bodyExcerpt: aiBodyExcerpt,
				}),
			async (review) => {
				const blogSource = resolveBlogSource(hostname);
				const source = await upsertSourceByOriginUrl({
					name: blogSource.name,
					type: 'blog',
					originUrl: blogSource.originUrl,
					metadata: createSourceMetadata(candidate.query, fetchedAt),
				});

				return upsertItemByExternalUrl(
					{
						sourceId: source.id,
						externalUrl,
						kind: DEFAULT_KIND,
						title,
						authors,
						summary: review.summary,
						publishedAt: extracted.publishedAt,
						updatedAt: extracted.modifiedAt,
						metadata: createItemMetadata(extracted, hostname, candidate, fetchedAt, review),
						version: bodyHash,
						body: truncateBodyForStorage(extracted.bodyText),
						aiAccepted: review.accepted,
						language: review.language,
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

export async function syncBlogCollection(options: BlogSyncOptions = {}): Promise<BlogSyncResult> {
	const queries = options.query?.trim() ? [options.query.trim()] : [...POKEMON_KEYWORDS];
	const count = parsePositiveInteger(options.count, 20);
	const offset = parseOptionalPositiveInteger(options.offset) ?? 0;
	const pages = parsePositiveInteger(options.pages, DEFAULT_PAGES);
	const fetchedAt = new Date().toISOString();

	const [{ candidates, requestsUsed }, existingTags] = await Promise.all([
		discoverCandidates(queries, count, offset, pages),
		fetchTopTagNames(),
	]);

	const itemResults = await mapWithConcurrency(candidates, IMPORT_CONCURRENCY, (candidate) =>
		processBlogCandidate(candidate, fetchedAt, existingTags),
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
		queries,
		count,
		offset,
		pages,
		requestsUsed,
		fetched: candidates.length,
		inserted,
		updated,
		skipped,
		fetchedAt,
		items: itemResults,
	};
}
