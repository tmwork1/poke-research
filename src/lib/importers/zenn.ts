// Zenn の非公式 API（/api/articles, /api/articles/{slug}）から記事を収集し、
// AI レビューとタグ同期を通して DB に反映する。ドキュメントのない API のため、
// User-Agent を明示し、Qiita より控えめな同時実行数で呼び出す。
import { reviewImportArticle } from './article-ai';
import { fetchTopTagNames, mapWithConcurrency, processImportItem, stripHtml, upsertItemByExternalUrl, upsertSourceByOriginUrl, type ImportItemOutcome } from './common';
import { ZENN_TOPICS } from './keywords';
import { parsePositiveInteger } from '../params';

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
}

export function resolveZennSyncOptions(env: ZennEnvDefaults, overrides: ZennSyncOptions = {}): Required<ZennSyncOptions> {
	return {
		topic: overrides.topic?.trim() || DEFAULT_TOPIC,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.ZENN_PAGES, 1)),
	};
}

function zennUrl(path: string): string {
	return `${ZENN_API_BASE}${path}`;
}

async function fetchZennListPage(topic: string, page: number): Promise<ZennListResponse> {
	const url = new URL(zennUrl('/articles'));
	url.searchParams.set('topicname', topic);
	url.searchParams.set('order', 'latest');
	url.searchParams.set('page', String(page));

	const response = await fetch(url, {
		headers: { 'User-Agent': 'pokemon-research-zenn-importer' },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Zenn API request failed (${response.status}): ${detail}`);
	}

	return (await response.json()) as ZennListResponse;
}

async function fetchZennArticleDetail(slug: string): Promise<ZennArticleDetail> {
	const response = await fetch(zennUrl(`/articles/${slug}`), {
		headers: { 'User-Agent': 'pokemon-research-zenn-importer' },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Zenn API request failed (${response.status}): ${detail}`);
	}

	// レスポンスは { article: {...} } の形で本体を包んでいる。
	const { article } = (await response.json()) as { article: ZennArticleDetail };
	return article;
}

async function fetchZennSlugs(topics: string[], pages: number): Promise<string[]> {
	// 複数トピック・複数ページ取得時に同一記事が再登場しても、1 件だけ残す。
	const slugs: string[] = [];
	const seen = new Set<string>();

	for (const topic of topics) {
		for (let page = 1; page <= pages; page += 1) {
			const { articles, next_page } = await fetchZennListPage(topic, page);
			if (articles.length === 0) break;

			for (const article of articles) {
				if (seen.has(article.slug)) continue;
				seen.add(article.slug);
				slugs.push(article.slug);
			}

			if (next_page === null) break;
		}
	}

	return slugs;
}

function articleUrl(detail: ZennArticleDetail): string {
	return `https://zenn.dev${detail.path}`;
}

function createAuthors(detail: ZennArticleDetail): string[] {
	const author = detail.user.name?.trim() || detail.user.username?.trim();
	return author ? [author] : [];
}

function extractTags(detail: ZennArticleDetail): string[] {
	return [...new Set((detail.topics ?? []).map((topic) => topic.name?.trim()).filter((name): name is string => Boolean(name)))];
}

function createAiBodyExcerpt(detail: ZennArticleDetail): string {
	// 長すぎる本文は OpenAI 送信用に切り詰めて、コストと応答の安定性を守る。
	const text = stripHtml(detail.body_html ?? '');
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

async function processZennSlug(slug: string, sourceId: number, topic: string, fetchedAt: string, existingTags: string[]): Promise<ImportItemOutcome> {
	// 詳細取得（非公式API）自体が失敗するケースも、記事単位の skipped として吸収する。
	try {
		const detail = await fetchZennArticleDetail(slug);
		const url = articleUrl(detail);

		return await processImportItem(
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
			(review) =>
				upsertItemByExternalUrl(
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
					},
					review.tags.length > 0 ? review.tags : extractTags(detail),
				),
		);
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl: `https://zenn.dev/articles/${slug}`,
			title: slug,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}

export async function syncZennCollection(options: ZennSyncOptions = {}): Promise<ZennSyncResult> {
	const topic = normalizeTopic(options.topic);
	const pages = parsePositiveInteger(options.pages, 1);
	const fetchedAt = new Date().toISOString();

	const [slugs, source, existingTags] = await Promise.all([
		fetchZennSlugs(splitTopics(topic), pages),
		upsertSourceByOriginUrl({
			name: ZENN_SOURCE_NAME,
			type: 'zenn',
			originUrl: ZENN_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(topic, fetchedAt, pages),
		}),
		fetchTopTagNames(),
	]);

	const itemResults = await mapWithConcurrency(slugs, IMPORT_CONCURRENCY, (slug) =>
		processZennSlug(slug, source.id, topic, fetchedAt, existingTags),
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
		topic,
		pages,
		fetched: slugs.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
