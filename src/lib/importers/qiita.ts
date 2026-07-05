// Qiita API から記事を収集し、AI レビューとタグ同期を通して DB に反映する。
// 収集条件や provenance も metadata に残して、再現できる形で保存する。
import { reviewImportArticle } from './article-ai';
import { fetchTopTagNames, mapWithConcurrency, processImportItem, stripHtml, upsertItemByExternalUrl, upsertSourceByOriginUrl, type ImportItemOutcome } from './common';
import { POKEMON_KEYWORDS } from './keywords';
import { parsePositiveInteger } from '../params';

const QIITA_API_URL = 'https://qiita.com/api/v2/items';
const QIITA_SOURCE_NAME = 'Qiita';
const QIITA_SOURCE_ORIGIN_URL = 'https://qiita.com/';
const DEFAULT_KIND = 'article';
// 本文全文一致だと「ポケモン」への一言だけの言及で無関係な記事まで拾ってしまうため、
// タイトルまたはタグでの絞り込みに限定する（M5: eval-collectionでの検証）。
// キーワード自体は keywords.ts の共通リストから組み立てる。
const DEFAULT_QUERY = [
	...POKEMON_KEYWORDS.map((keyword) => `title:${keyword}`),
	`tag:${POKEMON_KEYWORDS[0]}`,
].join(' OR ');
const MAX_AI_BODY_CHARS = 4000;

interface QiitaUser {
	id: string;
	name?: string | null;
	url_name?: string | null;
}

interface QiitaItem {
	id: string;
	title: string;
	url: string;
	rendered_body?: string | null;
	body?: string | null;
	created_at: string;
	updated_at: string;
	likes_count?: number;
	comments_count?: number;
	page_views_count?: number;
	private?: boolean;
	coediting?: boolean;
	user: QiitaUser;
	tags?: Array<{ name?: string | null }>;
}

export interface QiitaSyncOptions {
	query?: string;
	pages?: number;
	perPage?: number;
	token?: string;
}

export interface QiitaSyncResult {
	query: string;
	pages: number;
	perPage: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	sourceId: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

function normalizeQuery(query?: string): string {
	const trimmed = query?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUERY;
}

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う。
// 検索語（query）は収集内容の質に直結するため、env では管理せずコード（DEFAULT_QUERY）に一本化する。
export interface QiitaEnvDefaults {
	QIITA_PAGES?: string | number;
	QIITA_PER_PAGE?: string | number;
	QIITA_TOKEN?: string;
}

export function resolveQiitaSyncOptions(env: QiitaEnvDefaults, overrides: QiitaSyncOptions = {}): Required<QiitaSyncOptions> {
	return {
		query: overrides.query?.trim() || DEFAULT_QUERY,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.QIITA_PAGES, 1)),
		perPage: parsePositiveInteger(overrides.perPage, parsePositiveInteger(env.QIITA_PER_PAGE, 20)),
		token: overrides.token?.trim() || env.QIITA_TOKEN?.trim() || '',
	};
}

function createSummary(item: QiitaItem): string {
	// 本文が取れない場合はタイトルだけでも最低限の説明になるようにする。
	const body = item.rendered_body ?? item.body ?? '';
	const text = stripHtml(body);
	if (!text) {
		return item.title;
	}
	return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function createAuthors(item: QiitaItem): string[] {
	const author = item.user.name?.trim() || item.user.url_name?.trim() || item.user.id.trim();
	return author ? [author] : [];
}

function extractTags(item: QiitaItem): string[] {
	return [...new Set((item.tags ?? []).map((tag) => tag.name?.trim()).filter((tag): tag is string => Boolean(tag)))];
}

function createSourceMetadata(query: string, fetchedAt: string, perPage: number, pages: number) {
	// 取得条件は source metadata に残し、後から再現可能にしておく。
	return {
		service: 'qiita',
		api_url: QIITA_API_URL,
		origin_url: QIITA_SOURCE_ORIGIN_URL,
		collection: {
			query,
			per_page: perPage,
			pages,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(item: QiitaItem, query: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	// 取り込み元、再取得条件、AI 判定結果を 1 つのメタデータにまとめる。
	return {
		service: 'qiita',
		qiita: {
			id: item.id,
			likes_count: item.likes_count ?? 0,
			comments_count: item.comments_count ?? 0,
			page_views_count: item.page_views_count ?? 0,
			private: item.private ?? false,
			coediting: item.coediting ?? false,
			tags: extractTags(item),
		},
		provenance: {
			source: 'qiita-importer',
			query,
			fetched_at: fetchedAt,
			qiita_id: item.id,
			qiita_url: item.url,
			qiita_updated_at: item.updated_at,
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

function createAiBodyExcerpt(item: QiitaItem): string {
	// 長すぎる本文は OpenAI 送信用に切り詰めて、コストと応答の安定性を守る。
	const body = item.rendered_body ?? item.body ?? '';
	const text = stripHtml(body);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
}

async function fetchQiitaPage(query: string, page: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	const url = new URL(QIITA_API_URL);
	url.searchParams.set('query', query);
	url.searchParams.set('page', String(page));
	url.searchParams.set('per_page', String(perPage));

	const headers: HeadersInit = {
		'User-Agent': 'poke-research-qiita-importer',
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(url, { headers });
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Qiita API request failed (${response.status}): ${detail}`);
	}

	return (await response.json()) as QiitaItem[];
}

async function fetchQiitaItems(query: string, pages: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	// 複数ページ取得時に同一 URL が再登場しても、1 件だけ残す。
	const results: QiitaItem[] = [];
	const seen = new Set<string>();

	for (let page = 1; page <= pages; page += 1) {
		const items = await fetchQiitaPage(query, page, perPage, token);
		if (items.length === 0) {
			break;
		}

		for (const item of items) {
			if (seen.has(item.url)) {
				continue;
			}
			seen.add(item.url);
			results.push(item);
		}

		if (items.length < perPage) {
			break;
		}
	}

	return results;
}

const IMPORT_CONCURRENCY = 4;

export async function syncQiitaCollection(options: QiitaSyncOptions = {}): Promise<QiitaSyncResult> {
	const query = normalizeQuery(options.query);
	const pages = parsePositiveInteger(options.pages, 1);
	const perPage = parsePositiveInteger(options.perPage, 20);
	const fetchedAt = new Date().toISOString();

	const [items, source, existingTags] = await Promise.all([
		fetchQiitaItems(query, pages, perPage, options.token),
		upsertSourceByOriginUrl({
			name: QIITA_SOURCE_NAME,
			type: 'qiita',
			originUrl: QIITA_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(query, fetchedAt, perPage, pages),
		}),
		fetchTopTagNames(),
	]);

	const itemResults = await mapWithConcurrency(items, IMPORT_CONCURRENCY, (item) =>
		processImportItem(
			item.url,
			item.title,
			() =>
				reviewImportArticle({
					sourceName: QIITA_SOURCE_NAME,
					query,
					title: item.title,
					url: item.url,
					authors: createAuthors(item),
					sourceTags: extractTags(item),
					existingTags,
					createdAt: item.created_at,
					updatedAt: item.updated_at,
					bodyExcerpt: createAiBodyExcerpt(item),
				}),
			(review) =>
				upsertItemByExternalUrl(
					{
						sourceId: source.id,
						externalUrl: item.url,
						kind: DEFAULT_KIND,
						title: item.title,
						authors: createAuthors(item),
						summary: review.summary,
						publishedAt: item.created_at,
						updatedAt: item.updated_at,
						metadata: createItemMetadata(item, query, fetchedAt, review),
						version: item.updated_at,
					},
					review.tags.length > 0 ? review.tags : extractTags(item),
				),
		),
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
		query,
		pages,
		perPage,
		fetched: items.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
