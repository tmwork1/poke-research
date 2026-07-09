// arXiv API から論文（プレプリント）を収集し、AI レビューを通して DB に反映する。
// qiita.ts（API直取得・HTML本文取得不要）を最も近いパターンとして踏襲するが、次の点が異なる。
//   - items.kind は 'article' ではなく 'paper'（docs/plan/paper.md）。
//   - 本文（body）は HTML 記事本文ではなくアブストラクト全文をそのまま使う。
//   - 採否基準・要約文字数は article-ai.ts 経由で kind='paper' を渡し、
//     ai-review-prompt.mjs 側で論文向けに出し分ける。
//
// 収集クエリはキーワードのみで広く収集し、AIレビューを安全網にする方針を取る
// （Brave収集・はてなブックマーク収集と同じパターン。docs/plan/paper.md 参照）。
// ポケモンへの一言だけの言及で無関係な論文（例: 他ゲームのRL研究の一例として名前が出るだけ）が
// 混入しうるため、prompt 側の(2)基準で「論文全体を通じて主要な研究対象として扱っているか」を
// 問う内容にしている。
//
// arXiv API利用ポリシー（https://info.arxiv.org/help/api/tou.html）は連続リクエストの間隔を
// 空けることを求めているが、本インポーターは1回の収集で1リクエストのみ（ページング無し）の
// ため、qiita.ts のような複数ページ取得時の待機処理は不要（深刻な連続アクセスにならない）。
import { reviewImportArticle } from './article-ai';
import { canonicalizeArxivAbsUrl, parseArxivFeed, type ArxivFeedEntry } from './arxiv-feed';
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
import { parsePositiveInteger } from '../params';
import { topic } from '../../config/topic.config.mjs';

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const ARXIV_SOURCE_NAME = 'arXiv';
const ARXIV_SOURCE_ORIGIN_URL = 'https://arxiv.org/';
const DEFAULT_KIND = 'paper';
const MAX_AI_BODY_CHARS = 4000;
// 既存論文はAIレビュー・DB書き込みをスキップするため実質的な負荷は新着論文数に比例するが、
// 初回投入日・急増日のsubrequest数の頭打ちとして既定値は控えめにする（旧50→20）。
const DEFAULT_MAX_RESULTS = 20;
const IMPORT_CONCURRENCY = 4;

// arXivの検索構文（search_query）は日本語キーワードを扱えないため、topic.config.mjs の
// searchKeywords のうち英数字のみのもの（pokemon/pokeapi 等）を all: フィールドで束ねる
// （ai-review-prompt.mjs の englishSynonym 抽出と同じ絞り込みロジック）。
const ARXIV_KEYWORDS = POKEMON_KEYWORDS.filter((keyword) => /^[a-z0-9]+$/i.test(keyword));
// arXivの検索インデックスはアクセント記号のfoldingを行わないため、"pokemon"では
// "Pokémon"表記（アクセント付きé）のみを使う論文がヒットしない（実例:
// arXiv:2504.04395 "Human-Level Competitive Pokémon via..."。all:pokemonでは0件、
// all:pokémonでは別途32件ヒットを確認）。また"pokemon"は語（トークン）単位で照合されるため、
// スペース無しの複合語表記（例: "PokemonGO"）も別トークンとして扱われヒットしない（実例:
// arXiv:2304.02952 "Gotta Assess 'Em All: ... Facilitated through PokemonGO"。
// 2026-07-10、scripts/eval/eval-recall.mjs --source=arxiv での再現率チェックで発見）。
// pokemonを含むキーワードに限り、これらの表記も OR で束ねて取りこぼしを防ぐ。
const ARXIV_KEYWORD_VARIANTS: Record<string, string[]> = { pokemon: ['pokémon', 'pokemongo'] };
const ARXIV_QUERY_TERMS = ARXIV_KEYWORDS.flatMap((keyword) => {
	const variants = ARXIV_KEYWORD_VARIANTS[keyword.toLowerCase()] ?? [];
	return [keyword, ...variants];
});
const DEFAULT_QUERY = ARXIV_QUERY_TERMS.map((keyword) => `all:${keyword}`).join(' OR ');

export interface ArxivSyncOptions {
	query?: string;
	maxResults?: number;
	start?: number;
	maxNewItemsPerRun?: number;
}

export interface ArxivSyncResult {
	query: string;
	maxResults: number;
	start: number;
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

// API ルート（手動起動）と cron ジョブ（定期実行）の両方が同じ既定値解決ロジックを使う
// 前提で用意しているが、今回のスコープでは cron（wrangler.jsonc）への組み込みは行わない
// （Cloudflareアカウントのcron trigger数上限のため、docs/plan/paper.md 参照）。
// 検索語（query）は収集内容の質に直結するため、env では管理せずコード（DEFAULT_QUERY）に一本化する。
export interface ArxivEnvDefaults {
	ARXIV_MAX_RESULTS?: string | number;
	ARXIV_MAX_NEW_PER_RUN?: string | number;
}

// 新規論文1件あたりのsubrequestはOpenAIレビュー1回＋item upsert1回（assumeNewで既存チェックの
// selectを省略）の計2件（Qiitaと同構造、2026-07-09に実測で確認）。固定コスト（新規0件時で
// 実測5）に加え、新規記事が1件以上あるときだけ発生するタグ同期バッチの初回コスト（2件程度）を
// 合わせると、10件処理時のワーストケースは約27 subrequests程度（詳細はdocs/issue/cron-subrequest-limit.md参照）。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 10;

export function resolveArxivSyncOptions(env: ArxivEnvDefaults, overrides: ArxivSyncOptions = {}): Required<ArxivSyncOptions> {
	return {
		query: overrides.query?.trim() || DEFAULT_QUERY,
		maxResults: parsePositiveInteger(overrides.maxResults, parsePositiveInteger(env.ARXIV_MAX_RESULTS, DEFAULT_MAX_RESULTS)),
		// start=0（先頭から取得）が既定のため、0以上の整数を明示的に渡された場合だけ上書きする。
		start: Number.isInteger(overrides.start) && (overrides.start as number) >= 0 ? (overrides.start as number) : 0,
		// 新着論文が急増した日（例: 大きな学会の投稿ラッシュ）でも1回の実行でsubrequest上限を
		// 超えないよう、実際にAIレビュー・DB書き込みを行う新規件数に上限を設ける。超過分は
		// 次回実行に持ち越される（既存URL判定に残るため論文が失われることはない）。
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.ARXIV_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function extractArxivId(entryId: string): string {
	// 例: http://arxiv.org/abs/2401.01234v1 -> 2401.01234v1
	const match = entryId.match(/\/abs\/([^/]+)$/);
	return match ? match[1] : entryId;
}

function createAiBodyExcerpt(entry: ArxivFeedEntry): string {
	// アブストラクトはHTML記事本文と比べて短いため切り詰めが必要になることは稀だが、
	// OpenAI 送信用のコスト・応答安定性のため他インポーター同様に上限を設ける。
	return entry.summary.length > MAX_AI_BODY_CHARS ? entry.summary.slice(0, MAX_AI_BODY_CHARS) : entry.summary;
}

function createSourceMetadata(query: string, fetchedAt: string, maxResults: number, start: number) {
	return {
		service: 'arxiv',
		api_url: ARXIV_API_URL,
		origin_url: ARXIV_SOURCE_ORIGIN_URL,
		collection: {
			query,
			max_results: maxResults,
			start,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(entry: ArxivFeedEntry, query: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	const arxivId = extractArxivId(entry.id);
	return {
		service: 'arxiv',
		arxiv: {
			arxiv_id: arxivId,
			categories: entry.categories,
			primary_category: entry.primaryCategory,
		},
		provenance: {
			source: 'arxiv-importer',
			query,
			fetched_at: fetchedAt,
			arxiv_id: arxivId,
			arxiv_url: entry.id,
			arxiv_updated_at: entry.updated,
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

async function fetchArxivEntries(query: string, maxResults: number, start: number): Promise<ArxivFeedEntry[]> {
	const url = new URL(ARXIV_API_URL);
	url.searchParams.set('search_query', query);
	url.searchParams.set('start', String(start));
	url.searchParams.set('max_results', String(maxResults));
	url.searchParams.set('sortBy', 'submittedDate');
	url.searchParams.set('sortOrder', 'descending');

	const response = await fetch(url, {
		headers: { 'User-Agent': `${topic.site.slug}-arxiv-importer` },
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`arXiv API request failed (${response.status}): ${detail}`);
	}

	return parseArxivFeed(await response.text());
}

export async function syncArxivCollection(options: ArxivSyncOptions = {}): Promise<ArxivSyncResult> {
	const query = normalizeQuery(options.query);
	const maxResults = parsePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
	const start = Number.isInteger(options.start) && (options.start as number) >= 0 ? (options.start as number) : 0;
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const fetchedAt = new Date().toISOString();

	const [entries, source, existingTags] = await Promise.all([
		fetchArxivEntries(query, maxResults, start),
		upsertSourceByOriginUrl({
			name: ARXIV_SOURCE_NAME,
			type: 'arxiv',
			originUrl: ARXIV_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(query, fetchedAt, maxResults, start),
		}),
		fetchTopTagNames(),
	]);

	// 既に収集済みの候補は、AIレビュー・DB書き込みを行わずスキップする（記事内容の変更は追跡しない
	// 方針のため、判定は既存かどうかのみ。cronのsubrequest数・OpenAI課金を抑える）。
	const existingUrls = await findExistingExternalUrls(entries.map((entry) => canonicalizeArxivAbsUrl(entry.id)));

	// 新着論文が急増した日でも1回の実行でsubrequest上限を超えないよう、実際に処理する新規件数を
	// maxNewItemsPerRun件までに絞る。超えた分は次回実行時に既存URL判定に引っかからず自然に
	// 再度候補となる（論文が失われるわけではない）。
	const newEntries = entries.filter((entry) => !existingUrls.has(canonicalizeArxivAbsUrl(entry.id)));
	const entriesToProcess = new Set(newEntries.slice(0, maxNewItemsPerRun).map((entry) => canonicalizeArxivAbsUrl(entry.id)));

	// タグ同期はここでは行わず、新規記事の分だけためて最後にまとめて1回のバッチで行う
	// （ensureTags・item_tags insertをジョブ内で記事N件でも固定回数に抑える）。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const itemResults = await mapWithConcurrency(entries, IMPORT_CONCURRENCY, (entry) => {
		const externalUrl = canonicalizeArxivAbsUrl(entry.id);

		if (existingUrls.has(externalUrl)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl,
				title: entry.title,
				reason: 'already collected',
			});
		}

		if (!entriesToProcess.has(externalUrl)) {
			return Promise.resolve<ImportItemOutcome>({
				id: null,
				action: 'skipped',
				externalUrl,
				title: entry.title,
				reason: 'exceeded max new items per run',
			});
		}

		return processImportItem(
			externalUrl,
			entry.title,
			() =>
				reviewImportArticle({
					sourceName: ARXIV_SOURCE_NAME,
					query,
					title: entry.title,
					url: externalUrl,
					authors: entry.authors,
					sourceTags: entry.categories,
					existingTags,
					createdAt: entry.published ?? undefined,
					updatedAt: entry.updated ?? undefined,
					bodyExcerpt: createAiBodyExcerpt(entry),
					kind: DEFAULT_KIND,
				}),
			(review) =>
				upsertItemByExternalUrl(
					{
						sourceId: source.id,
						externalUrl,
						kind: DEFAULT_KIND,
						title: entry.title,
						authors: entry.authors,
						summary: review.summary,
						publishedAt: entry.published,
						updatedAt: entry.updated,
						metadata: createItemMetadata(entry, query, fetchedAt, review),
						version: entry.updated ?? entry.id,
						collectionRoute: 'arxiv-importer',
						body: truncateBodyForStorage(entry.summary),
						aiAccepted: review.accepted,
						language: review.language,
						aiRecheckModel: review.model,
						aiRecheckPromptHash: review.promptHash,
						aiRecheckReason: review.reason,
						aiRecheckConfidence: review.confidence ?? null,
					},
					// arXivのcategory（cs.AI等）は分類コードであり、ユーザー向けタグとしての可読性に
					// 欠けるため、qiita.tsと異なりフォールバックには使わずAIレビューのtagsのみを使う
					// （hatena.tsと同じ方針。sourceTagsとしてはAIレビューの判断材料に渡している）。
					review.tags,
					undefined,
					// 直前に existingUrls でこの候補が新規であることを確認済みのため、
					// upsertItemByExternalUrl 内の既存行チェック（select）を省略できる。タグ同期は
					// ここでは行わず（syncTags: false）、下の pendingTagEntries でまとめて行う。
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
		query,
		maxResults,
		start,
		fetched: entries.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}
