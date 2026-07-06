// note の非公式 API（/api/v3/searches, /api/v3/notes/{key}）から記事を収集し、
// AI レビューとタグ同期を通して DB に反映する。ドキュメントのない API のため、
// User-Agent を明示し、Zenn 同様に控えめな同時実行数で呼び出す。
// 有料・メンバーシップ限定（プレビューのみ）の記事は本文を取得できないため収集対象外とする。
import { reviewImportArticle } from './article-ai';
import {
	fetchTopTagNames,
	mapWithConcurrency,
	processImportItem,
	stripHtml,
	truncateBodyForStorage,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
} from './common';
import { POKEMON_KEYWORDS } from './keywords';
import { parsePositiveInteger } from '../params';

const NOTE_API_BASE = 'https://note.com/api/v3';
const NOTE_SOURCE_NAME = 'note';
const NOTE_SOURCE_ORIGIN_URL = 'https://note.com/';
const DEFAULT_KIND = 'article';
// キーワード自体は keywords.ts の共通リストから取る（note は単一クエリのみ対応）。
const DEFAULT_QUERY = POKEMON_KEYWORDS[0];
const MAX_AI_BODY_CHARS = 4000;
const IMPORT_CONCURRENCY = 2;

interface NoteSearchItem {
	key: string;
	can_read: boolean;
	price: number;
	is_limited: boolean;
}

interface NoteSearchResponse {
	data: {
		notes: {
			contents: NoteSearchItem[];
			is_last_page: boolean | null;
		};
	};
}

interface NoteDetail {
	key: string;
	name: string;
	body?: string | null;
	note_url: string;
	publish_at: string;
	can_read: boolean;
	user: { nickname?: string | null; urlname?: string | null };
	hashtag_notes?: Array<{ hashtag?: { name?: string | null } }>;
	like_count?: number;
	comment_count?: number;
	price?: number;
}

export interface NoteSyncOptions {
	query?: string;
	pages?: number;
	perPage?: number;
}

export interface NoteSyncResult {
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
export interface NoteEnvDefaults {
	NOTE_PAGES?: string | number;
	NOTE_PER_PAGE?: string | number;
}

export function resolveNoteSyncOptions(env: NoteEnvDefaults, overrides: NoteSyncOptions = {}): Required<NoteSyncOptions> {
	return {
		query: overrides.query?.trim() || DEFAULT_QUERY,
		pages: parsePositiveInteger(overrides.pages, parsePositiveInteger(env.NOTE_PAGES, 1)),
		perPage: parsePositiveInteger(overrides.perPage, parsePositiveInteger(env.NOTE_PER_PAGE, 10)),
	};
}

function noteUrl(path: string): string {
	return `${NOTE_API_BASE}${path}`;
}

async function fetchNoteSearchPage(query: string, start: number, size: number): Promise<NoteSearchResponse['data']['notes']> {
	const url = new URL(noteUrl('/searches'));
	url.searchParams.set('context', 'note');
	url.searchParams.set('q', query);
	url.searchParams.set('size', String(size));
	url.searchParams.set('start', String(start));

	const response = await fetch(url, {
		headers: { 'User-Agent': 'poke-research-note-importer' },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`note API request failed (${response.status}): ${detail}`);
	}

	const payload = (await response.json()) as NoteSearchResponse;
	return payload.data.notes;
}

async function fetchNoteDetail(key: string): Promise<NoteDetail> {
	const response = await fetch(noteUrl(`/notes/${key}`), {
		headers: { 'User-Agent': 'poke-research-note-importer' },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`note API request failed (${response.status}): ${detail}`);
	}

	const { data } = (await response.json()) as { data: NoteDetail };
	return data;
}

async function fetchReadableNoteKeys(query: string, pages: number, perPage: number): Promise<string[]> {
	// 有料・メンバーシップ限定（can_read=false）は本文が取得できないため、一覧の時点で除外する。
	const keys: string[] = [];
	const seen = new Set<string>();

	for (let page = 0; page < pages; page += 1) {
		const { contents } = await fetchNoteSearchPage(query, page * perPage, perPage);
		if (contents.length === 0) break;

		for (const item of contents) {
			if (!item.can_read || seen.has(item.key)) continue;
			seen.add(item.key);
			keys.push(item.key);
		}

		if (contents.length < perPage) break;
	}

	return keys;
}

function createAuthors(detail: NoteDetail): string[] {
	const author = detail.user.nickname?.trim() || detail.user.urlname?.trim();
	return author ? [author] : [];
}

function extractTags(detail: NoteDetail): string[] {
	return [
		...new Set(
			(detail.hashtag_notes ?? [])
				.map((entry) => entry.hashtag?.name?.trim())
				.filter((name): name is string => Boolean(name))
				.map((name) => name.replace(/^#/, '')),
		),
	];
}

function extractBodyText(detail: NoteDetail): string {
	return stripHtml(detail.body ?? '');
}

function createAiBodyExcerpt(detail: NoteDetail): string {
	// 長すぎる本文は OpenAI 送信用に切り詰めて、コストと応答の安定性を守る。
	const text = extractBodyText(detail);
	return text.length > MAX_AI_BODY_CHARS ? text.slice(0, MAX_AI_BODY_CHARS) : text;
}

function createSourceMetadata(query: string, fetchedAt: string, pages: number, perPage: number) {
	// 取得条件は source metadata に残し、後から再現可能にしておく。
	return {
		service: 'note',
		api_url: noteUrl('/searches'),
		origin_url: NOTE_SOURCE_ORIGIN_URL,
		collection: {
			query,
			pages,
			per_page: perPage,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(detail: NoteDetail, query: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	// 取り込み元、再取得条件、AI 判定結果を 1 つのメタデータにまとめる。
	return {
		service: 'note',
		note: {
			key: detail.key,
			like_count: detail.like_count ?? 0,
			comment_count: detail.comment_count ?? 0,
			price: detail.price ?? 0,
		},
		provenance: {
			source: 'note-importer',
			query,
			fetched_at: fetchedAt,
			note_key: detail.key,
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

async function processNoteKey(key: string, sourceId: number, query: string, fetchedAt: string, existingTags: string[]): Promise<ImportItemOutcome> {
	// 詳細取得（非公式API）自体が失敗するケースも、記事単位の skipped として吸収する。
	try {
		const detail = await fetchNoteDetail(key);
		if (!detail.can_read) {
			return { id: null, action: 'skipped', externalUrl: detail.note_url, title: detail.name, reason: 'paid or membership-limited note' };
		}

		return await processImportItem(
			detail.note_url,
			detail.name,
			() =>
				reviewImportArticle({
					sourceName: NOTE_SOURCE_NAME,
					query,
					title: detail.name,
					url: detail.note_url,
					authors: createAuthors(detail),
					sourceTags: extractTags(detail),
					existingTags,
					createdAt: detail.publish_at,
					updatedAt: detail.publish_at,
					bodyExcerpt: createAiBodyExcerpt(detail),
				}),
			(review) =>
				upsertItemByExternalUrl(
					{
						sourceId,
						externalUrl: detail.note_url,
						kind: DEFAULT_KIND,
						title: detail.name,
						authors: createAuthors(detail),
						summary: review.summary,
						publishedAt: detail.publish_at,
						updatedAt: null,
						metadata: createItemMetadata(detail, query, fetchedAt, review),
						version: detail.publish_at,
						body: truncateBodyForStorage(extractBodyText(detail)),
					},
					review.tags.length > 0 ? review.tags : extractTags(detail),
				),
		);
	} catch (error) {
		return {
			id: null,
			action: 'skipped',
			externalUrl: `https://note.com/notes/${key}`,
			title: key,
			reason: error instanceof Error ? error.message : 'unknown error',
		};
	}
}

export async function syncNoteCollection(options: NoteSyncOptions = {}): Promise<NoteSyncResult> {
	const query = normalizeQuery(options.query);
	const pages = parsePositiveInteger(options.pages, 1);
	const perPage = parsePositiveInteger(options.perPage, 10);
	const fetchedAt = new Date().toISOString();

	const [keys, source, existingTags] = await Promise.all([
		fetchReadableNoteKeys(query, pages, perPage),
		upsertSourceByOriginUrl({
			name: NOTE_SOURCE_NAME,
			type: 'note',
			originUrl: NOTE_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(query, fetchedAt, pages, perPage),
		}),
		fetchTopTagNames(),
	]);

	const itemResults = await mapWithConcurrency(keys, IMPORT_CONCURRENCY, (key) =>
		processNoteKey(key, source.id, query, fetchedAt, existingTags),
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
		fetched: keys.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
