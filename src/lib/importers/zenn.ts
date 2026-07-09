// Zenn の非公式 API（/api/articles, /api/articles/{slug}）から記事を収集し、
// AI レビューとタグ同期を通して DB に反映する。ドキュメントのない API のため、
// User-Agent を明示し、Qiita より控えめな同時実行数で呼び出す。
import { reviewImportArticle } from './article-ai';
import {
	fetchTopTagNames,
	findExistingExternalUrls,
	mapWithConcurrency,
	processImportItem,
	stripHtml,
	syncNewItemTagsBatch,
	truncateBodyForStorage,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
	type ItemTagSyncEntry,
} from './common';
import { ZENN_TOPICS } from './keywords';
import { parsePositiveInteger } from '../params';
import { topic } from '../../config/topic.config.mjs';

const ZENN_API_BASE = 'https://zenn.dev/api';
const ZENN_SOURCE_NAME = 'Zenn';
const ZENN_SOURCE_ORIGIN_URL = 'https://zenn.dev/';
const DEFAULT_KIND = 'article';
// 対象トピックは keywords.ts の共通リストから取る。カンマ区切りで複数指定できる
// （例: "pokemon,pokemongo"）。取得時はトピックごとに叩いてマージ・重複排除する。
const DEFAULT_TOPIC = ZENN_TOPICS.join(',');
const MAX_AI_BODY_CHARS = 4000;
const IMPORT_CONCURRENCY = 2;

interface ZennListArticle {
	slug: string;
	// 一覧APIの時点で記事パス（＝URL）が分かるため、詳細取得(fetchZennArticleDetail)なしに
	// 既収集判定ができる（記事内容の変更は追跡しない方針のため、判定はURLの既存有無のみでよい）。
	path: string;
}

interface ZennListResponse {
	articles: ZennListArticle[];
	next_page: number | null;
}

interface ZennArticleDetail {
	id: number;
	slug: string;
	title: string;
	path: string;
	published_at: string;
	body_updated_at?: string | null;
	body_html?: string | null;
	topics?: Array<{ name?: string | null }>;
	user: { username: string; name?: string | null };
	liked_count?: number;
	comments_count?: number;
	article_type?: string;
}

export interface ZennSyncOptions {
	topic?: string;
	pages?: number;
	maxNewItemsPerRun?: number;
}

export interface ZennSyncResult {
	topic: string;
	pages: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	sourceId: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

function normalizeTopic(topic?: string): string {
	const trimmed = topic?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TOPIC;
}

// カンマ区切りの topic 文字列を、取得用の個別トピック配列に分解する。
function splitTopics(topic: string): string[] {
	return [...new Set(topic.split(',').map((t) => t.trim()).filter((t) => t.length > 0))];
}

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
// 対象トピック（topic）は収集内容の質に直結するため、env では管理せずコード（DEFAULT_TOPIC）に一本化する。
export interface ZennEnvDefaults {
	ZENN_PAGES?: string | number;
	ZENN_MAX_NEW_PER_RUN?: string | number;
}

// 新規記事1件あたりのsubrequestは詳細取得1回＋OpenAIレビュー1回＋item upsert1回の計3件
// （Qiita/arXivと異なりassumeNew非対応のため既存チェックのselectも残る）。固定コストと
// 合わせ、8件処理時のワーストケースは実測で約29 subrequests程度のため、Qiita/arXivより
// 控えめにする（詳細はdocs/progress/2026-07-09.md「MAX_NEW_PER_RUNの再調整要否を検討」）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 8;

export function resolveZennSyncOptions(env: ZennEnvDefaults, overrides: ZennSyncOptions = {}): Required<ZennSyncOptions> {
	return {
		topic: overrides.topic?.trim() || DEFAULT_TOPIC,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.ZENN_PAGES, 1)),
		// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数に
		// 上限を設ける。超過分は次回実行に持ち越される（既存URL判定に残るため記事が失われることはない）。
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.ZENN_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function zennUrl(path: string): string {
	return `${ZENN_API_BASE}${path}`;
}

async function fetchZennListPage(topicName: string, page: number): Promise<ZennListResponse> {
	const url = new URL(zennUrl('/articles'));
	url.searchParams.set('topicname', topicName);
	url.searchParams.set('order', 'latest');
	url.searchParams.set('page', String(page));

	const response = await fetch(url, {
		headers: { 'User-Agent': `${topic.site.slug}-zenn-importer` },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Zenn API request failed (${response.status}): ${detail}`);
	}

	return (await response.json()) as ZennListResponse;
}

async function fetchZennArticleDetail(slug: string): Promise<ZennArticleDetail> {
	const response = await fetch(zennUrl(`/articles/${slug}`), {
		headers: { 'User-Agent': `${topic.site.slug}-zenn-importer` },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Zenn API request failed (${response.status}): ${detail}`);
	}

	// レスポンスは { article: {...} } の形で本体を包んでいる。
	const { article } = (await response.json()) as { article: ZennArticleDetail };
	return article;
}

async function fetchZennListArticles(topics: string[], pages: number): Promise<ZennListArticle[]> {
	// 複数トピック・複数ページ取得時に同一記事が再登場しても、1 件だけ残す。
	const articlesFound: ZennListArticle[] = [];
	const seen = new Set<string>();

	for (const topic of topics) {
		for (let page = 1; page <= pages; page += 1) {
			const { articles, next_page } = await fetchZennListPage(topic, page);
			if (articles.length === 0) break;

			for (const article of articles) {
				if (seen.has(article.slug)) continue;
				seen.add(article.slug);
				articlesFound.push(article);
			}

			if (next_page === null) break;
		}
	}

	return articlesFound;
}

function pathToUrl(path: string): string {
	return `https://zenn.dev${path}`;
}

function articleUrl(detail: ZennArticleDetail): string {
	return pathToUrl(detail.path);
}

function createAuthors(detail: ZennArticleDetail): string[] {
	const author = detail.user.name?.trim() || detail.user.username?.trim();
	return author ? [author] : [];
}

function extractTags(detail: ZennArticleDetail): string[] {
	return [...new Set((detail.topics ?? []).map((topic) => topic.name?.trim()).filter((name): name is string => Boolean(name)))];
}

function extractBodyText(detail: ZennArticleDetail): string {
	return stripHtml(detail.body_html ?? '');
}

function createAiBodyExcerpt(detail: ZennArticleDetail): string {
	// 長すぎる本文は OpenAI 送信用に切り詰めて、コストと応答の安定性を守る。
	const text = extractBodyText(detail);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
}

function createSourceMetadata(topic: string, fetchedAt: string, pages: number) {
	// 取得条件は source metadata に残し、後から再現可能にしておく。
	return {
		service: 'zenn',
		api_url: zennUrl('/articles'),
		origin_url: ZENN_SOURCE_ORIGIN_URL,
		collection: {
			topic,
			pages,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(detail: ZennArticleDetail, topic: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	// 取り込み元、再取得条件、AI 判定結果を 1 つのメタデータにまとめる。
	return {
		service: 'zenn',
		zenn: {
			id: detail.id,
			liked_count: detail.liked_count ?? 0,
			comments_count: detail.comments_count ?? 0,
			article_type: detail.article_type ?? null,
			topics: extractTags(detail),
		},
		provenance: {
			source: 'zenn-importer',
			topic,
			fetched_at: fetchedAt,
			zenn_id: detail.id,
			zenn_slug: detail.slug,
			zenn_body_updated_at: detail.body_updated_at ?? null,
		},
		ai: {
			model: aiReview.model,
			accepted: aiReview.accepted,
			reason: aiReview.reason,
			confidence: aiReview.confidence ?? null,
			summary: aiReview.summary,
			tags: aiReview.tags,
		},
	};
}

interface ZennDetailFetchResult {
	slug: string;
	detail: ZennArticleDetail | null;
	error?: string;
}

async function fetchZennDetailSafely(slug: string): Promise<ZennDetailFetchResult> {
	// 詳細取得（非公式API）自体が失敗するケースも、記事単位の skipped として吸収する。
	try {
		return { slug, detail: await fetchZennArticleDetail(slug) };
	} catch (error) {
		return { slug, detail: null, error: error instanceof Error ? error.message : 'unknown error' };
	}
}

async function reviewAndUpsertZennArticle(
	detail: ZennArticleDetail,
	sourceId: number,
	topic: string,
	fetchedAt: string,
	existingTags: string[],
	pendingTagEntries: ItemTagSyncEntry[],
): Promise<ImportItemOutcome> {
	const url = articleUrl(detail);

	return processImportItem(
		url,
		detail.title,
		() =>
			reviewImportArticle({
				sourceName: ZENN_SOURCE_NAME,
				query: topic,
				title: detail.title,
				url,
				authors: createAuthors(detail),
				sourceTags: extractTags(detail),
				existingTags,
				createdAt: detail.published_at,
				updatedAt: detail.body_updated_at ?? detail.published_at,
				bodyExcerpt: createAiBodyExcerpt(detail),
			}),
		(review) => {
			const tags = review.tags.length > 0 ? review.tags : extractTags(detail);
			return upsertItemByExternalUrl(
				{
					sourceId,
					externalUrl: url,
					kind: DEFAULT_KIND,
					title: detail.title,
					authors: createAuthors(detail),
					summary: review.summary,
					publishedAt: detail.published_at,
					updatedAt: detail.body_updated_at ?? detail.published_at,
					metadata: createItemMetadata(detail, topic, fetchedAt, review),
					version: detail.body_updated_at ?? detail.published_at,
					collectionRoute: 'zenn-importer',
					body: truncateBodyForStorage(extractBodyText(detail)),
					aiAccepted: review.accepted,
					language: review.language,
				},
				tags,
				undefined,
				// 直前に existingUrls でこの記事が新規であることを確認済みのため、
				// upsertItemByExternalUrl 内の既存行チェック（select）を省略できる。タグ同期は
				// ここでは行わず（syncTags: false）、呼び出し元でまとめて行う。
				{ syncTags: false, assumeNew: true },
			).then((result) => {
				if (review.accepted) pendingTagEntries.push({ itemId: result.id, tags });
				return result;
			});
		},
	);
}

export async function syncZennCollection(options: ZennSyncOptions = {}): Promise<ZennSyncResult> {
	const topic = normalizeTopic(options.topic);
	const pages = parsePositiveInteger(options.pages, 1);
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const fetchedAt = new Date().toISOString();

	const [listArticles, source, existingTags] = await Promise.all([
		fetchZennListArticles(splitTopics(topic), pages),
		upsertSourceByOriginUrl({
			name: ZENN_SOURCE_NAME,
			type: 'zenn',
			originUrl: ZENN_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(topic, fetchedAt, pages),
		}),
		fetchTopTagNames(),
	]);

	// 一覧APIの時点で記事パス（＝URL）が分かるため、詳細取得(fetchZennArticleDetail)なしに
	// まとめて既存かどうかを判定できる（記事内容の変更は追跡しない方針のため、判定は既存有無のみ）。
	// 既に収集済みの記事は詳細取得自体を省略でき、新規記事だけが対象になる
	// （cronのsubrequest数・OpenAI課金を抑える）。
	const existingUrls = await findExistingExternalUrls(listArticles.map((article) => pathToUrl(article.path)));
	const newArticles = listArticles.filter((article) => !existingUrls.has(pathToUrl(article.path)));

	// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、詳細取得以降の処理を行う
	// 新規件数をmaxNewItemsPerRun件までに絞る。超過分は詳細取得自体を省略してスキップし、
	// 次回実行時に既存URL判定に引っかからず自然に再度候補となる（記事が失われるわけではない）。
	const articlesToProcess = newArticles.slice(0, maxNewItemsPerRun);
	const deferredArticles = newArticles.slice(maxNewItemsPerRun);

	const detailResults = await mapWithConcurrency(articlesToProcess, IMPORT_CONCURRENCY, (article) => fetchZennDetailSafely(article.slug));

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const processedResults = await mapWithConcurrency(detailResults, IMPORT_CONCURRENCY, (result) => {
		if (!result.detail) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl: `https://zenn.dev/articles/${result.slug}`,
				title: result.slug,
				reason: result.error ?? 'unknown error',
			});
		}

		return reviewAndUpsertZennArticle(result.detail, source.id, topic, fetchedAt, existingTags, pendingTagEntries);
	});

	await syncNewItemTagsBatch(pendingTagEntries);

	const skippedKnownResults: ImportItemOutcome[] = listArticles
		.filter((article) => existingUrls.has(pathToUrl(article.path)))
		.map((article) => ({
			id: null,
			action: 'skipped',
			externalUrl: pathToUrl(article.path),
			title: article.slug,
			reason: 'already collected',
		}));

	const deferredResults: ImportItemOutcome[] = deferredArticles.map((article) => ({
		id: null,
		action: 'skipped',
		externalUrl: pathToUrl(article.path),
		title: article.slug,
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
		topic,
		pages,
		fetched: listArticles.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
