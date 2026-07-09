// Qiita API から記事を収集し、AI レビューとタグ同期を通して DB に反映する。
// 収集条件や provenance も metadata に残して、再現できる形で保存する。
import { buildTagLabels, reviewImportArticle } from './article-ai';
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
import { POKEMON_KEYWORDS } from './keywords';
import { parsePositiveInteger } from '../params';
import { topic } from '../../config/topic.config.mjs';

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
	maxNewItemsPerRun?: number;
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
	QIITA_MAX_NEW_PER_RUN?: string | number;
}

// 新着記事1件の処理（AIレビュー・DB書き込み）にかかるsubrequest数から、1回の実行あたり
// この件数までなら単独でCloudflareのsubrequest上限に収まる、という既定値。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 10;

export function resolveQiitaSyncOptions(env: QiitaEnvDefaults, overrides: QiitaSyncOptions = {}): Required<QiitaSyncOptions> {
	return {
		query: overrides.query?.trim() || DEFAULT_QUERY,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.QIITA_PAGES, 1)),
		// 既存記事はAIレビュー・DB書き込みをスキップするため実質的な負荷は新着記事数に比例するが、
		// 初回投入日・急増日のsubrequest数の頭打ちとして既定値は控えめにする（旧20→10）。
		perPage: parsePositiveInteger(overrides.perPage, parsePositiveInteger(env.QIITA_PER_PAGE, 10)),
		token: overrides.token?.trim() || env.QIITA_TOKEN?.trim() || '',
		// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、実際にAIレビュー・
		// DB書き込みを行う新規件数に上限を設ける。超過分は次回実行に持ち越される（既存URL判定に
		// 残るため記事が失われることはない）。
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.QIITA_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function extractBodyText(item: QiitaItem): string {
	const body = item.rendered_body ?? item.body ?? '';
	return stripHtml(body);
}

function createSummary(item: QiitaItem): string {
	// 本文が取れない場合はタイトルだけでも最低限の説明になるようにする。
	const text = extractBodyText(item);
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
	const text = extractBodyText(item);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
}

async function fetchQiitaPage(query: string, page: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	const url = new URL(QIITA_API_URL);
	url.searchParams.set('query', query);
	url.searchParams.set('page', String(page));
	url.searchParams.set('per_page', String(perPage));

	const headers: HeadersInit = {
		'User-Agent': `${topic.site.slug}-qiita-importer`,
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

// Qiita の検索APIは明示的なソート順を保証しないため、設定ページ数の最後のページが
// 全て DB 既知の記事だった場合は、新着記事が後続ページに埋もれている可能性を疑って
// 数ページだけ追加取得する（無制限だとAPI消費が膨らむため上限を設ける）。
const MAX_EXTRA_PAGES = 3;

async function fetchQiitaItems(query: string, pages: number, perPage: number, token?: string): Promise<QiitaItem[]> {
	// 複数ページ取得時に同一 URL が再登場しても、1 件だけ残す。
	const results: QiitaItem[] = [];
	const seen = new Set<string>();
	let extraPagesUsed = 0;

	for (let page = 1; page <= pages + MAX_EXTRA_PAGES; page += 1) {
		const items = await fetchQiitaPage(query, page, perPage, token);
		if (items.length === 0) {
			break;
		}

		const pageItems: QiitaItem[] = [];
		for (const item of items) {
			if (seen.has(item.url)) {
				continue;
			}
			seen.add(item.url);
			results.push(item);
			pageItems.push(item);
		}

		if (items.length < perPage) {
			break;
		}

		if (page >= pages) {
			if (extraPagesUsed >= MAX_EXTRA_PAGES) {
				break;
			}
			const existingUrls = await findExistingExternalUrls(pageItems.map((item) => item.url));
			const allKnown = pageItems.length > 0 && pageItems.every((item) => existingUrls.has(item.url));
			if (!allKnown) {
				break;
			}
			extraPagesUsed += 1;
		}
	}

	return results;
}

const IMPORT_CONCURRENCY = 4;

export async function syncQiitaCollection(options: QiitaSyncOptions = {}): Promise<QiitaSyncResult> {
	const query = normalizeQuery(options.query);
	const pages = parsePositiveInteger(options.pages, 1);
	const perPage = parsePositiveInteger(options.perPage, 20);
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
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

	// 既に収集済みの候補は、AIレビュー・DB書き込みを行わずスキップする（記事内容の変更は追跡しない
	// 方針のため、判定は既存かどうかのみ。cronのsubrequest数・OpenAI課金を抑える）。
	const existingUrls = await findExistingExternalUrls(items.map((item) => item.url));

	// 新着記事が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数を
	// maxNewItemsPerRun件までに絞る。超えた分は「既存」ではなく「今回は未処理」としてスキップし、
	// 次回実行時に既存URL判定に引っかからず自然に再度候補となる（記事が失われるわけではない）。
	const newItems = items.filter((item) => !existingUrls.has(item.url));
	const itemsToProcess = new Set(newItems.slice(0, maxNewItemsPerRun).map((item) => item.url));

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const itemResults = await mapWithConcurrency(items, IMPORT_CONCURRENCY, (item) => {
		if (existingUrls.has(item.url)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl: item.url,
				title: item.title,
				reason: 'already collected',
			});
		}

		if (!itemsToProcess.has(item.url)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl: item.url,
				title: item.title,
				reason: 'exceeded max new items per run',
			});
		}

		return processImportItem(
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
			(review) => {
				const tags = review.tags.length > 0 ? review.tags : extractTags(item);
				return upsertItemByExternalUrl(
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
						collectionRoute: 'qiita-importer',
						body: truncateBodyForStorage(extractBodyText(item)),
						aiAccepted: review.accepted,
						language: review.language,
					},
					tags,
					undefined,
					// 直前に existingUrls でこの候補が新規であることを確認済みのため、
					// upsertItemByExternalUrl 内の既存行チェック（select）を省略できる。タグ同期は
					// ここでは行わず（syncTags: false）、下の pendingTagEntries でまとめて行う。
					{ syncTags: false, assumeNew: true },
				).then((result) => {
					if (review.accepted) pendingTagEntries.push({ itemId: result.id, tags });
					return result;
				});
			},
		);
	});

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
