// OpenAlex Works API から論文を収集し、AI レビューを通して DB に反映する。
// arxiv.ts を最も近いパターンとして踏襲するが、次の点が異なる。
//   - OpenAlexはJSON APIで構造化データを返すため、arXivのAtom XMLパーサー（arxiv-feed.ts）に
//     相当するものは不要。代わりにレスポンス整形の純粋関数を openalex-parse.ts に持つ。
//   - APIキーが必須（無料キーで1日$1相当。src/lib/openalex.ts 参照）。
//   - アブストラクトは abstract_inverted_index（単語 -> 出現位置）形式でしか提供されないため、
//     openalex-parse.ts の reconstructAbstract で平文に復元してから body/AIレビュー入力に使う。
//   - arXiv由来と判定できたworkは、arxiv.ts と同じ正規化URLを external_url に使うことで、
//     UNIQUE制約（items.external_url、migrations/002）を介して同一論文が別行として
//     重複登録されるのを防ぐ（openalex-parse.ts の selectExternalUrl 参照）。
//
// 収集クエリはキーワードのみで広く収集し、AIレビューを安全網にする方針を取る（arXivと同じ）。
//
// 2026-07-10、手動起動での動作確認・subrequest実測を経て worker.ts の DAILY_SLOT_JOBS
// （分30スロット）へ組み込み済み（docs/issue/cron-subrequest-limit.md参照）。
// 手動起動用API（POST /api/import/openalex）も引き続き利用できる。
import { reviewImportArticle } from './article-ai';
import { computePromptHash } from './ai-review-prompt.mjs';
import {
	fetchTopTagNames,
	findExistingExternalUrls,
	mapWithConcurrency,
	processImportItem,
	syncNewItemTagsBatch,
	truncateBodyForStorage,
	upsertItemByExternalUrl,
	upsertSourceByOriginUrl,
	type ImportItemOutcome,
	type ItemTagSyncEntry,
} from './common';
import { POKEMON_KEYWORDS } from './keywords';
import {
	buildOpenAlexFilter,
	extractAuthors,
	reconstructAbstract,
	resolveTitle,
	selectExternalUrl,
	type OpenAlexWork,
} from './openalex-parse';
import { parsePositiveInteger } from '../params';
import { getOpenAlexConfig, OPENALEX_API_URL } from '../openalex';
import { topic } from '../../config/topic.config.mjs';

const OPENALEX_SOURCE_NAME = 'OpenAlex';
const OPENALEX_SOURCE_ORIGIN_URL = 'https://openalex.org/';
const DEFAULT_KIND = 'paper';
const MAX_AI_BODY_CHARS = 4000;
const DEFAULT_MAX_RESULTS = 20;
const IMPORT_CONCURRENCY = 4;

// OpenAlexのfilter構文は日本語キーワードを扱えないため、topic.config.mjs の searchKeywords の
// うち英数字のみのもの（pokemon 等。'pokeapi'は2026-07-10にノイズ源として除外済み、
// keywords.ts参照）を束ねる（arxiv.ts の ARXIV_KEYWORDS と同じ絞り込み）。
const OPENALEX_KEYWORDS = POKEMON_KEYWORDS.filter((keyword) => /^[a-z0-9]+$/i.test(keyword));
const DEFAULT_FILTER = buildOpenAlexFilter(OPENALEX_KEYWORDS);

export interface OpenAlexSyncOptions {
	filter?: string;
	maxResults?: number;
	maxNewItemsPerRun?: number;
	// OpenAlexの基本ページング（page=1始まり、10,000件まで対応）。日次収集は既定値1
	// （最新発行日順の先頭maxResults件）のみを見るが、arXiv同様の一度きりの過去分初期投入
	// （ローカルで手動起動を繰り返す）では2以降を指定して遡って取得する（arxiv.tsのstartと同用途）。
	page?: number;
}

export interface OpenAlexSyncResult {
	filter: string;
	maxResults: number;
	page: number;
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	sourceId: number;
	fetchedAt: string;
	items: ImportItemOutcome[];
}

function normalizeFilter(filter?: string): string {
	const trimmed = filter?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_FILTER;
}

// API ルート（手動起動）と cron ジョブ（将来組み込む場合）の両方が同じ既定値解決ロジックを使う
// 前提で用意している。検索語（filter）は収集内容の質に直結するため、env では管理せず
// コード（DEFAULT_FILTER）に一本化する（arxiv.ts と同方針）。
export interface OpenAlexEnvDefaults {
	OPENALEX_MAX_RESULTS?: string | number;
	OPENALEX_MAX_NEW_PER_RUN?: string | number;
}

// 2026-07-10、ローカルでCloudflare Workers subrequest数を実測して確定（DEBUG_SUBREQUEST_COUNT、
// docs/issue/cron-subrequest-limit.md参照）。固定コスト5、新規1件あたり3（OpenAIレビュー1＋
// item upsert1＋ai_prompt_hashes記録1、assumeNew）。arxiv.tsの「新規1件あたり2」という
// 見積りはai_prompt_hashesテーブル（migrations/026、PR #65）追加前のqiitaからの類推のままで
// 更新されておらず、実際はarxiv.ts等の既存インポーターも同じ+1が乗っているはずだが、そちらの
// 再測定は本対応のスコープ外とする。新規12件が全件新規だった場合のワーストケースは
// 5+12×3+2（タグ同期バッチ概算）=43で、Cloudflareの1回あたり上限50に対しqiita/zenn/arxiv
// （27〜33）と同程度の安全マージンを残せる値として12を採用した（cron統合に伴い10から引き上げ）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 12;

export function resolveOpenAlexSyncOptions(env: OpenAlexEnvDefaults, overrides: OpenAlexSyncOptions = {}): Required<OpenAlexSyncOptions> {
	return {
		filter: overrides.filter?.trim() || DEFAULT_FILTER,
		maxResults: parsePositiveInteger(overrides.maxResults, parsePositiveInteger(env.OPENALEX_MAX_RESULTS, DEFAULT_MAX_RESULTS)),
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.OPENALEX_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
		page: Number.isInteger(overrides.page) && (overrides.page as number) >= 1 ? (overrides.page as number) : 1,
	};
}

function createAiBodyExcerpt(abstract: string): string {
	// OpenAI 送信用のコスト・応答安定性のため他インポーター同様に上限を設ける。
	return abstract.length > MAX_AI_BODY_CHARS ? abstract.slice(0, MAX_AI_BODY_CHARS) : abstract;
}

function createSourceMetadata(filter: string, fetchedAt: string, maxResults: number, page: number) {
	return {
		service: 'openalex',
		api_url: OPENALEX_API_URL,
		origin_url: OPENALEX_SOURCE_ORIGIN_URL,
		collection: {
			filter,
			max_results: maxResults,
			page,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(work: OpenAlexWork, filter: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	return {
		service: 'openalex',
		openalex: {
			openalex_id: work.id,
			doi: work.doi ?? null,
			type: work.type ?? null,
			is_oa: work.open_access?.is_oa ?? null,
			cited_by_count: work.cited_by_count ?? null,
			indexed_in: work.indexed_in ?? [],
		},
		provenance: {
			source: 'openalex-importer',
			query: filter,
			fetched_at: fetchedAt,
			openalex_id: work.id,
			openalex_updated_at: work.updated_date ?? null,
		},
		ai: {
			model: aiReview.model,
			prompt_hash: aiReview.promptHash,
			accepted: aiReview.accepted,
			reason: aiReview.reason,
			confidence: aiReview.confidence ?? null,
			summary: aiReview.summary,
			tags: aiReview.tags,
		},
	};
}

interface OpenAlexWorksResponse {
	results?: OpenAlexWork[];
}

async function fetchOpenAlexWorks(filter: string, maxResults: number, apiKey: string, page: number): Promise<OpenAlexWork[]> {
	const url = new URL(OPENALEX_API_URL);
	url.searchParams.set('filter', filter);
	url.searchParams.set('sort', 'publication_date:desc');
	url.searchParams.set('per_page', String(maxResults));
	url.searchParams.set('page', String(page));
	url.searchParams.set('api_key', apiKey);

	const response = await fetch(url, {
		headers: { 'User-Agent': `${topic.site.slug}-openalex-importer` },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`OpenAlex API request failed (${response.status}): ${detail}`);
	}

	const payload = (await response.json()) as OpenAlexWorksResponse;
	return payload.results ?? [];
}

export async function syncOpenAlexCollection(options: OpenAlexSyncOptions = {}): Promise<OpenAlexSyncResult> {
	const filter = normalizeFilter(options.filter);
	const maxResults = parsePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const page = Number.isInteger(options.page) && (options.page as number) >= 1 ? (options.page as number) : 1;
	const fetchedAt = new Date().toISOString();

	const { apiKey } = getOpenAlexConfig();
	if (!apiKey) {
		// API キーがない場合は、誤った無通信のまま進めず明示的に失敗させる。
		throw new Error('OPENALEX_API_KEY is required to sync OpenAlex works');
	}

	const [works, source, existingTags] = await Promise.all([
		fetchOpenAlexWorks(filter, maxResults, apiKey, page),
		upsertSourceByOriginUrl({
			name: OPENALEX_SOURCE_NAME,
			type: 'openalex',
			originUrl: OPENALEX_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(filter, fetchedAt, maxResults, page),
		}),
		fetchTopTagNames(),
	]);

	// 既に収集済みの候補は、AIレビュー・DB書き込みを行わずスキップする（arXiv由来で既にDBにある
	// 行も selectExternalUrl が同じ正規化URLを返すためここで自然にスキップされる）。
	const existingUrls = await findExistingExternalUrls(works.map((work) => selectExternalUrl(work)));

	// 新着論文が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数を
	// maxNewItemsPerRun件までに絞る（arxiv.ts と同方針）。
	const newWorks = works.filter((work) => !existingUrls.has(selectExternalUrl(work)));
	const worksToProcess = new Set(newWorks.slice(0, maxNewItemsPerRun).map((work) => selectExternalUrl(work)));

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const itemResults = await mapWithConcurrency(works, IMPORT_CONCURRENCY, (work) => {
		const externalUrl = selectExternalUrl(work);
		const title = resolveTitle(work);

		if (existingUrls.has(externalUrl)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl,
				title,
				reason: 'already collected',
			});
		}

		if (!worksToProcess.has(externalUrl)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl,
				title,
				reason: 'exceeded max new items per run',
			});
		}

		const abstract = reconstructAbstract(work.abstract_inverted_index);
		const authors = extractAuthors(work);

		return processImportItem(
			externalUrl,
			title,
			() =>
				reviewImportArticle({
					sourceName: OPENALEX_SOURCE_NAME,
					query: filter,
					title,
					url: externalUrl,
					authors,
					sourceTags: [],
					existingTags,
					createdAt: work.publication_date ?? undefined,
					updatedAt: work.updated_date ?? undefined,
					bodyExcerpt: createAiBodyExcerpt(abstract),
					kind: DEFAULT_KIND,
				}),
			(review) =>
				upsertItemByExternalUrl(
					{
						sourceId: source.id,
						externalUrl,
						kind: DEFAULT_KIND,
						title,
						authors,
						summary: review.summary,
						publishedAt: work.publication_date ?? null,
						updatedAt: work.updated_date ?? null,
						metadata: createItemMetadata(work, filter, fetchedAt, review),
						version: work.updated_date ?? work.id,
						collectionRoute: 'openalex-importer',
						body: truncateBodyForStorage(abstract),
						aiAccepted: review.accepted,
						language: review.language,
						aiRecheckModel: review.model,
						aiRecheckPromptHash: review.promptHash,
						aiRecheckReason: review.reason,
						aiRecheckConfidence: review.confidence ?? null,
					},
					// arxiv.ts と同方針: sourceTagsはAIレビューの判断材料に渡すのみで、フォールバックには使わない。
					review.tags,
					undefined,
					// 直前に existingUrls でこの候補が新規であることを確認済みのため、
					// upsertItemByExternalUrl 内の既存行チェック（select）を省略できる。
					{ syncTags: false, assumeNew: true },
				).then((result) => {
					if (review.accepted) pendingTagEntries.push({ itemId: result.id, tags: review.tags });
					return result;
				}),
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
		filter,
		maxResults,
		page,
		fetched: works.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}

// 2026-07-10、OpenAlex過去分の手動バックフィル用（一度きり）。ユーザー指示により、この
// バックフィル分のみOpenAIのAIレビューを使わず、Claude Codeセッション内のHaikuサブエージェントに
// 直接判定させる（cronの日次収集は今まで通りOpenAI・reviewImportArticleを使う、article-ai.tsは
// 変更しない）。判定ロジック自体はDB書き込みの正しさに直結するため独自実装せず、既存のDB書き込み
// パス（upsertItemByExternalUrl・syncNewItemTagsBatch等）をそのまま再利用し、判定結果の
// 出所（OpenAI呼び出し vs 手動セッション判定）だけを切り替えられるようにしている。

export interface OpenAlexCandidate {
	externalUrl: string;
	title: string;
	authors: string[];
	abstract: string;
	openalexId: string;
	doi: string | null;
	type: string | null;
	isOa: boolean | null;
	citedByCount: number | null;
	indexedIn: string[];
	publishedAt: string | null;
	updatedAt: string | null;
	version: string;
}

export interface OpenAlexCandidatesResult {
	filter: string;
	maxResults: number;
	page: number;
	fetched: number;
	candidates: OpenAlexCandidate[];
	sourceId: number;
	fetchedAt: string;
}

// AIレビュー（reviewImportArticle）を呼ばず、DB未収録の候補を生データのまま返す
// （手動セッション判定用。DB書き込みは行わない）。
export async function fetchOpenAlexCandidates(options: OpenAlexSyncOptions = {}): Promise<OpenAlexCandidatesResult> {
	const filter = normalizeFilter(options.filter);
	const maxResults = parsePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
	const page = Number.isInteger(options.page) && (options.page as number) >= 1 ? (options.page as number) : 1;
	const fetchedAt = new Date().toISOString();

	const { apiKey } = getOpenAlexConfig();
	if (!apiKey) {
		throw new Error('OPENALEX_API_KEY is required to sync OpenAlex works');
	}

	const [works, source] = await Promise.all([
		fetchOpenAlexWorks(filter, maxResults, apiKey, page),
		upsertSourceByOriginUrl({
			name: OPENALEX_SOURCE_NAME,
			type: 'openalex',
			originUrl: OPENALEX_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(filter, fetchedAt, maxResults, page),
		}),
	]);

	const existingUrls = await findExistingExternalUrls(works.map((work) => selectExternalUrl(work)));
	const newWorks = works.filter((work) => !existingUrls.has(selectExternalUrl(work)));

	const candidates: OpenAlexCandidate[] = newWorks.map((work) => ({
		externalUrl: selectExternalUrl(work),
		title: resolveTitle(work),
		authors: extractAuthors(work),
		abstract: reconstructAbstract(work.abstract_inverted_index),
		openalexId: work.id,
		doi: work.doi ?? null,
		type: work.type ?? null,
		isOa: work.open_access?.is_oa ?? null,
		citedByCount: work.cited_by_count ?? null,
		indexedIn: work.indexed_in ?? [],
		publishedAt: work.publication_date ?? null,
		updatedAt: work.updated_date ?? null,
		version: work.updated_date ?? work.id,
	}));

	return { filter, maxResults, page, fetched: works.length, candidates, sourceId: source.id, fetchedAt };
}

export interface OpenAlexManualReview extends OpenAlexCandidate {
	accepted: boolean;
	summary: string;
	tags: string[];
	reason: string;
	confidence?: number;
	language: string;
}

// 手動セッション判定であることをDB上で識別できるよう、モデル名に明記する
// （items.ai_recheck_model・ai_review_model、docs/progress/2026-07-10.md参照）。
export const MANUAL_SESSION_REVIEW_MODEL = 'claude-haiku-4-5-20251001 (manual session review, no API)';

export interface ApplyOpenAlexReviewsResult {
	sourceId: number;
	inserted: number;
	updated: number;
	skipped: number;
	items: ImportItemOutcome[];
}

// Haikuサブエージェントが判定した結果を受け取り、既存の本番DB書き込みパスでそのまま保存する。
// reviewImportArticle（OpenAI）を経由しない点以外はsyncOpenAlexCollectionの後半と同じ処理。
export async function applyOpenAlexReviews(filter: string, reviews: OpenAlexManualReview[]): Promise<ApplyOpenAlexReviewsResult> {
	const fetchedAt = new Date().toISOString();
	const source = await upsertSourceByOriginUrl({
		name: OPENALEX_SOURCE_NAME,
		type: 'openalex',
		originUrl: OPENALEX_SOURCE_ORIGIN_URL,
		metadata: createSourceMetadata(filter, fetchedAt, reviews.length, 0),
	});
	// システムプロンプト自体はOpenAIレビューと同一のもの（ai-review-prompt.mjsのbuildSystemPrompt）を
	// サブエージェントへの指示に使うため、prompt_hashも同じ関数で計算し比較可能にする。
	const promptHash = await computePromptHash(topic, DEFAULT_KIND);

	const pendingTagEntries: ItemTagSyncEntry[] = [];
	const items: ImportItemOutcome[] = [];

	for (const entry of reviews) {
		const metadata = {
			service: 'openalex',
			openalex: {
				openalex_id: entry.openalexId,
				doi: entry.doi,
				type: entry.type,
				is_oa: entry.isOa,
				cited_by_count: entry.citedByCount,
				indexed_in: entry.indexedIn,
			},
			provenance: {
				source: 'openalex-importer-manual-backfill',
				query: filter,
				fetched_at: fetchedAt,
				openalex_id: entry.openalexId,
				openalex_updated_at: entry.updatedAt,
			},
			ai: {
				model: MANUAL_SESSION_REVIEW_MODEL,
				prompt_hash: promptHash,
				accepted: entry.accepted,
				reason: entry.reason,
				confidence: entry.confidence ?? null,
				summary: entry.summary,
				tags: entry.tags,
			},
		};

		const result = await upsertItemByExternalUrl(
			{
				sourceId: source.id,
				externalUrl: entry.externalUrl,
				kind: DEFAULT_KIND,
				title: entry.title,
				authors: entry.authors,
				summary: entry.summary,
				publishedAt: entry.publishedAt,
				updatedAt: entry.updatedAt,
				metadata,
				version: entry.version,
				collectionRoute: 'openalex-importer',
				body: truncateBodyForStorage(entry.abstract),
				aiAccepted: entry.accepted,
				language: entry.language,
				aiRecheckModel: MANUAL_SESSION_REVIEW_MODEL,
				aiRecheckPromptHash: promptHash,
				aiRecheckReason: entry.reason,
				aiRecheckConfidence: entry.confidence ?? null,
			},
			entry.tags,
			undefined,
			{ syncTags: false, assumeNew: true },
		);
		if (entry.accepted) pendingTagEntries.push({ itemId: result.id, tags: entry.tags });
		items.push({ id: result.id, action: result.action, externalUrl: entry.externalUrl, title: entry.title, reason: entry.accepted ? undefined : entry.reason });
	}

	await syncNewItemTagsBatch(pendingTagEntries);

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	for (const result of items) {
		if (result.action === 'inserted') inserted += 1;
		else if (result.action === 'updated') updated += 1;
		else skipped += 1;
	}

	return { sourceId: source.id, inserted, updated, skipped, items };
}
