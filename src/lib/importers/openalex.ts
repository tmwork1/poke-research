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
// cronには組み込まず、手動起動（POST /api/import/openalex）のみとする。まず数回分の収集内容を
// 確認してから、worker.ts の DAILY_SLOT_JOBS へスロット追加するかを別途判断する。
import { reviewImportArticle } from './article-ai';
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
// うち英数字のみのもの（pokemon/pokeapi 等）を束ねる（arxiv.ts の ARXIV_KEYWORDS と同じ絞り込み）。
const OPENALEX_KEYWORDS = POKEMON_KEYWORDS.filter((keyword) => /^[a-z0-9]+$/i.test(keyword));
const DEFAULT_FILTER = buildOpenAlexFilter(OPENALEX_KEYWORDS);

export interface OpenAlexSyncOptions {
	filter?: string;
	maxResults?: number;
	maxNewItemsPerRun?: number;
}

export interface OpenAlexSyncResult {
	filter: string;
	maxResults: number;
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

// arXiv同様、新規論文1件あたりのsubrequestはOpenAIレビュー1回＋item upsert1回の計2件と見込み、
// 初回投入日・急増日のsubrequest数の頭打ちとして控えめな既定値にする（実測しながら後日調整）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 10;

export function resolveOpenAlexSyncOptions(env: OpenAlexEnvDefaults, overrides: OpenAlexSyncOptions = {}): Required<OpenAlexSyncOptions> {
	return {
		filter: overrides.filter?.trim() || DEFAULT_FILTER,
		maxResults: parsePositiveInteger(overrides.maxResults, parsePositiveInteger(env.OPENALEX_MAX_RESULTS, DEFAULT_MAX_RESULTS)),
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.OPENALEX_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function createAiBodyExcerpt(abstract: string): string {
	// OpenAI 送信用のコスト・応答安定性のため他インポーター同様に上限を設ける。
	return abstract.length > MAX_AI_BODY_CHARS ? abstract.slice(0, MAX_AI_BODY_CHARS) : abstract;
}

function createSourceMetadata(filter: string, fetchedAt: string, maxResults: number) {
	return {
		service: 'openalex',
		api_url: OPENALEX_API_URL,
		origin_url: OPENALEX_SOURCE_ORIGIN_URL,
		collection: {
			filter,
			max_results: maxResults,
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

async function fetchOpenAlexWorks(filter: string, maxResults: number, apiKey: string): Promise<OpenAlexWork[]> {
	const url = new URL(OPENALEX_API_URL);
	url.searchParams.set('filter', filter);
	url.searchParams.set('sort', 'publication_date:desc');
	url.searchParams.set('per_page', String(maxResults));
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
	const fetchedAt = new Date().toISOString();

	const { apiKey } = getOpenAlexConfig();
	if (!apiKey) {
		// API キーがない場合は、誤った無通信のまま進めず明示的に失敗させる。
		throw new Error('OPENALEX_API_KEY is required to sync OpenAlex works');
	}

	const [works, source, existingTags] = await Promise.all([
		fetchOpenAlexWorks(filter, maxResults, apiKey),
		upsertSourceByOriginUrl({
			name: OPENALEX_SOURCE_NAME,
			type: 'openalex',
			originUrl: OPENALEX_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(filter, fetchedAt, maxResults),
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
		fetched: works.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
