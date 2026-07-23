// GitHub Search API からポケモン関連リポジトリを収集し、AI レビューを通して DB に反映する。
// openalex.ts を最も近いパターンとして踏襲するが、次の点が異なる。
//   - 検索はGitHub REST APIのSearch repositories（/search/repositories）を使い、認証は
//     GITHUB_TOKEN（スコープ不要のPAT）を必須にする（未認証だと後述のREADME取得を含む
//     core APIレート制限が60req/hrしかなく即枯渇するため）。
//   - AIレビューの入力（bodyExcerpt）には、検索結果に含まれないREADME本文を候補ごとに
//     別途取得して使う（GET /repos/{owner}/{repo}/readme、Accept: application/vnd.github.raw）。
//   - フォークは検索クエリ側（fork:false）で除外し、AIレビューにフォーク判定を持たせない
//     （機械的に安価に判定できるため、README取得・AIレビューの無駄なsubrequestも避けられる）。
//
// 収集クエリはキーワードのみで広く収集し、AIレビューを安全網にする方針を取る（arXiv/OpenAlexと同じ）。
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
import { buildGithubSearchQuery, extractOwnerLogin, resolveTitle, selectExternalUrl, type GithubRepository } from './github-parse';
import { POKEMON_KEYWORDS } from './keywords';
import { parsePositiveInteger } from '../params';
import { getGithubConfig, GITHUB_API_BASE_URL, GITHUB_SEARCH_REPOSITORIES_URL } from '../github';
import { topic } from '../../config/topic.config.mjs';

const GITHUB_SOURCE_NAME = 'GitHub';
const GITHUB_SOURCE_ORIGIN_URL = 'https://github.com/';
const DEFAULT_KIND = 'repo';
const MAX_AI_BODY_CHARS = 4000;
const DEFAULT_MAX_RESULTS = 20;
const IMPORT_CONCURRENCY = 4;

// OpenAlex/arXiv同様、topic.config.mjsのsearchKeywordsのうち英数字のみのキーワード
// （日本語キーワードはGitHub検索クエリで扱えないため除外）を使う。
const GITHUB_KEYWORDS = POKEMON_KEYWORDS.filter((keyword) => /^[a-z0-9]+$/i.test(keyword));
const DEFAULT_QUERY = buildGithubSearchQuery(GITHUB_KEYWORDS);

export interface GithubSyncOptions {
	query?: string;
	maxResults?: number;
	maxNewItemsPerRun?: number;
	// GitHub Search APIのページング（1始まり）。日次収集は既定値1のみを見るが、初期投入の
	// 手動バックフィル（fetchGithubCandidates）では2以降を指定して100件を超える件数を集める
	// （openalex.tsのpageと同用途）。
	page?: number;
}

export interface GithubSyncResult {
	query: string;
	maxResults: number;
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

export interface GithubEnvDefaults {
	GITHUB_MAX_RESULTS?: string | number;
	GITHUB_MAX_NEW_PER_RUN?: string | number;
}

// 2026-07-22時点では実測前のため、arxiv.ts/openalex.tsのワーストケース見積り（固定コスト5、
// 新規1件あたり3：AIレビュー1＋item upsert1＋ai_prompt_hashes記録1）に、README取得の
// +1 subrequestを加えた値を保守的な初期値として採用する。
const DEFAULT_MAX_NEW_ITEMS_PER_RUN = 10;

export function resolveGithubSyncOptions(env: GithubEnvDefaults, overrides: GithubSyncOptions = {}): Required<GithubSyncOptions> {
	return {
		query: overrides.query?.trim() || DEFAULT_QUERY,
		maxResults: parsePositiveInteger(overrides.maxResults, parsePositiveInteger(env.GITHUB_MAX_RESULTS, DEFAULT_MAX_RESULTS)),
		maxNewItemsPerRun: parsePositiveInteger(
			overrides.maxNewItemsPerRun,
			parsePositiveInteger(env.GITHUB_MAX_NEW_PER_RUN, DEFAULT_MAX_NEW_ITEMS_PER_RUN),
		),
	};
}

function createAiBodyExcerpt(readme: string): string {
	return readme.length > MAX_AI_BODY_CHARS ? readme.slice(0, MAX_AI_BODY_CHARS) : readme;
}

function createSourceMetadata(query: string, fetchedAt: string, maxResults: number) {
	return {
		service: 'github',
		api_url: GITHUB_SEARCH_REPOSITORIES_URL,
		origin_url: GITHUB_SOURCE_ORIGIN_URL,
		collection: {
			query,
			max_results: maxResults,
			fetched_at: fetchedAt,
		},
	};
}

function createItemMetadata(repo: GithubRepository, query: string, fetchedAt: string, aiReview: Awaited<ReturnType<typeof reviewImportArticle>>) {
	return {
		service: 'github',
		github: {
			id: repo.id,
			stargazers_count: repo.stargazers_count,
			forks_count: repo.forks_count,
			// 検索クエリで fork:false を指定済みだが、万一機能しなかった場合に事後監査できるよう記録のみ行う。
			is_fork: repo.fork,
			// GitHubのプログラミング言語（Python/JS等）。items.languageはREADMEの自然言語(ISO639-1)を
			// 指す既存の意味のため混同しないよう metadata.github 側に格納する。
			primary_language: repo.language ?? null,
			topics: repo.topics ?? [],
			archived: repo.archived ?? false,
			pushed_at: repo.pushed_at ?? null,
		},
		provenance: {
			source: 'github-importer',
			query,
			fetched_at: fetchedAt,
			repo_id: repo.id,
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

interface GithubSearchResponse {
	items?: GithubRepository[];
}

function githubHeaders(token: string, accept: string): HeadersInit {
	const headers: Record<string, string> = {
		Accept: accept,
		'User-Agent': `${topic.site.slug}-github-importer`,
		'X-GitHub-Api-Version': '2022-11-28',
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function fetchGithubRepositories(query: string, maxResults: number, token: string, page = 1): Promise<GithubRepository[]> {
	const url = new URL(GITHUB_SEARCH_REPOSITORIES_URL);
	url.searchParams.set('q', query);
	url.searchParams.set('sort', 'stars');
	url.searchParams.set('order', 'desc');
	// GitHub Search API は per_page の上限が100のため、100件を超える件数が必要な場合は
	// 呼び出し側（fetchGithubCandidates）が page を進めて複数回に分けて呼ぶ（openalex.tsの
	// 過去分バックフィルと同じ、手動で複数回叩く前提の設計）。
	url.searchParams.set('per_page', String(Math.min(maxResults, 100)));
	url.searchParams.set('page', String(page));

	const response = await fetch(url, { headers: githubHeaders(token, 'application/vnd.github+json') });
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GitHub search API request failed (${response.status}): ${detail}`);
	}

	const payload = (await response.json()) as GithubSearchResponse;
	return payload.items ?? [];
}

// READMEが存在しないリポジトリはGitHub APIが404を返すため、空文字にフォールバックする
// （AIレビューのSTEP2「README空」判定に自然に落ちる）。
async function fetchReadme(repo: Pick<GithubRepository, 'full_name'>, token: string): Promise<string> {
	const url = `${GITHUB_API_BASE_URL}/repos/${repo.full_name}/readme`;
	const response = await fetch(url, { headers: githubHeaders(token, 'application/vnd.github.raw') });
	if (response.status === 404) return '';
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GitHub README request failed for ${repo.full_name} (${response.status}): ${detail}`);
	}
	return response.text();
}

export async function syncGithubCollection(options: GithubSyncOptions = {}): Promise<GithubSyncResult> {
	const query = normalizeQuery(options.query);
	const maxResults = parsePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
	const maxNewItemsPerRun = parsePositiveInteger(options.maxNewItemsPerRun, DEFAULT_MAX_NEW_ITEMS_PER_RUN);
	const fetchedAt = new Date().toISOString();

	const { token } = getGithubConfig();
	if (!token) {
		// トークンが無いと検索は10req/min、README取得を含むcore APIは60req/hrしかなく実運用に
		// 耐えないため、誤った低レートのまま進めず明示的に失敗させる（openalex.tsのAPIキー必須方針と同じ）。
		throw new Error('GITHUB_TOKEN is required to sync GitHub repositories');
	}

	const [repos, source, existingTags] = await Promise.all([
		fetchGithubRepositories(query, maxResults, token),
		upsertSourceByOriginUrl({
			name: GITHUB_SOURCE_NAME,
			type: 'github',
			originUrl: GITHUB_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(query, fetchedAt, maxResults),
		}),
		fetchTopTagNames(),
	]);

	// 既に収集済みの候補は、README取得・AIレビュー・DB書き込みを行わずスキップする。
	const existingUrls = await findExistingExternalUrls(repos.map((repo) => selectExternalUrl(repo)));

	// 新着リポジトリが急増した場合でも1回の実行でsubrequest上限を超えないよう、実際に処理する
	// 新規件数をmaxNewItemsPerRun件までに絞る（arxiv.ts/openalex.tsと同方針）。
	const newRepos = repos.filter((repo) => !existingUrls.has(selectExternalUrl(repo)));
	const reposToProcess = new Set(newRepos.slice(0, maxNewItemsPerRun).map((repo) => selectExternalUrl(repo)));

	// タグ同期はここでは行わず、新規リポジトリの分だけためて最後にまとめて1回のバッチで行う。
	const pendingTagEntries: ItemTagSyncEntry[] = [];

	const itemResults = await mapWithConcurrency(repos, IMPORT_CONCURRENCY, async (repo) => {
		const externalUrl = selectExternalUrl(repo);
		const title = resolveTitle(repo);

		if (existingUrls.has(externalUrl)) {
			return { id: null, action: 'skipped', externalUrl, title, reason: 'already collected' } as ImportItemOutcome;
		}

		if (!reposToProcess.has(externalUrl)) {
			return { id: null, action: 'skipped', externalUrl, title, reason: 'exceeded max new items per run' } as ImportItemOutcome;
		}

		const readme = await fetchReadme(repo, token);
		const authors = extractOwnerLogin(repo);

		return processImportItem(
			externalUrl,
			title,
			() =>
				reviewImportArticle({
					sourceName: GITHUB_SOURCE_NAME,
					query,
					title,
					url: externalUrl,
					authors,
					sourceTags: repo.topics ?? [],
					existingTags,
					createdAt: repo.created_at ?? undefined,
					updatedAt: repo.pushed_at ?? undefined,
					bodyExcerpt: createAiBodyExcerpt(readme),
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
						publishedAt: repo.created_at ?? null,
						updatedAt: repo.pushed_at ?? null,
						metadata: createItemMetadata(repo, query, fetchedAt, review),
						version: repo.pushed_at ?? String(repo.id),
						collectionRoute: 'github-importer',
						body: truncateBodyForStorage(readme),
						aiAccepted: review.accepted,
						language: review.language,
						aiRecheckModel: review.model,
						aiRecheckPromptHash: review.promptHash,
						aiRecheckReason: review.reason,
						aiRecheckConfidence: review.confidence ?? null,
					},
					// arxiv.ts/openalex.tsと同方針: sourceTags(topics)はAIレビューの判断材料に渡すのみで、フォールバックには使わない。
					review.tags,
					undefined,
					// 直前にexistingUrlsでこの候補が新規であることを確認済みのため、
					// upsertItemByExternalUrl内の既存行チェック（select）を省略できる。
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
		fetched: repos.length,
		inserted,
		updated,
		skipped,
		sourceId: source.id,
		fetchedAt,
		items: itemResults,
	};
}

// 2026-07-23、GitHubリポジトリの初期投入バックフィル用（一度きり）。ユーザー指示により、この
// バックフィル分のみOpenAIのAIレビューを使わず、Claude Codeセッション内のサブエージェントに
// 直接判定させる（cronの日次収集は今まで通りOpenAI・reviewImportArticleを使う、article-ai.tsは
// 変更しない）。openalex.tsのOpenAlex過去分バックフィル（fetchOpenAlexCandidates/
// applyOpenAlexReviews）と同じ2段構成: 判定ロジック自体はDB書き込みの正しさに直結するため
// 独自実装せず、既存のDB書き込みパス（upsertItemByExternalUrl・syncNewItemTagsBatch等）を
// そのまま再利用し、判定結果の出所（OpenAI呼び出し vs 手動セッション判定）だけを切り替える。

export interface GithubCandidate {
	externalUrl: string;
	title: string;
	authors: string[];
	readmeExcerpt: string;
	repoId: number;
	stargazersCount: number;
	forksCount: number;
	primaryLanguage: string | null;
	topics: string[];
	archived: boolean;
	createdAt: string | null;
	pushedAt: string | null;
	version: string;
}

export interface GithubCandidatesResult {
	query: string;
	maxResults: number;
	page: number;
	fetched: number;
	candidates: GithubCandidate[];
	sourceId: number;
	fetchedAt: string;
}

// AIレビュー（reviewImportArticle）を呼ばず、DB未収録の候補をREADME付きで返す
// （手動セッション判定用。DB書き込みは行わない）。
export async function fetchGithubCandidates(options: GithubSyncOptions = {}): Promise<GithubCandidatesResult> {
	const query = normalizeQuery(options.query);
	const maxResults = parsePositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
	const page = Number.isInteger(options.page) && (options.page as number) >= 1 ? (options.page as number) : 1;
	const fetchedAt = new Date().toISOString();

	const { token } = getGithubConfig();
	if (!token) {
		throw new Error('GITHUB_TOKEN is required to sync GitHub repositories');
	}

	const [repos, source] = await Promise.all([
		fetchGithubRepositories(query, maxResults, token, page),
		upsertSourceByOriginUrl({
			name: GITHUB_SOURCE_NAME,
			type: 'github',
			originUrl: GITHUB_SOURCE_ORIGIN_URL,
			metadata: createSourceMetadata(query, fetchedAt, maxResults),
		}),
	]);

	const existingUrls = await findExistingExternalUrls(repos.map((repo) => selectExternalUrl(repo)));
	const newRepos = repos.filter((repo) => !existingUrls.has(selectExternalUrl(repo)));

	const candidates = await mapWithConcurrency(newRepos, IMPORT_CONCURRENCY, async (repo) => {
		const readme = await fetchReadme(repo, token);
		return {
			externalUrl: selectExternalUrl(repo),
			title: resolveTitle(repo),
			authors: extractOwnerLogin(repo),
			readmeExcerpt: createAiBodyExcerpt(readme),
			repoId: repo.id,
			stargazersCount: repo.stargazers_count,
			forksCount: repo.forks_count,
			primaryLanguage: repo.language ?? null,
			topics: repo.topics ?? [],
			archived: repo.archived ?? false,
			createdAt: repo.created_at ?? null,
			pushedAt: repo.pushed_at ?? null,
			version: repo.pushed_at ?? String(repo.id),
		} satisfies GithubCandidate;
	});

	return { query, maxResults, page, fetched: repos.length, candidates, sourceId: source.id, fetchedAt };
}

export interface GithubManualReview extends GithubCandidate {
	accepted: boolean;
	summary: string;
	tags: string[];
	reason: string;
	confidence?: number;
	language: string;
}

// 手動セッション判定であることをDB上で識別できるよう、モデル名に明記する
// （items.ai_recheck_model、openalex.tsのMANUAL_SESSION_REVIEW_MODELと同じ方針）。
export const GITHUB_MANUAL_SESSION_REVIEW_MODEL = 'claude (manual session review, no API)';

export interface ApplyGithubReviewsResult {
	sourceId: number;
	inserted: number;
	updated: number;
	skipped: number;
	items: ImportItemOutcome[];
}

// サブエージェントが判定した結果を受け取り、既存の本番DB書き込みパスでそのまま保存する。
// reviewImportArticle（OpenAI）を経由しない点以外はsyncGithubCollectionの後半と同じ処理。
export async function applyGithubReviews(query: string, reviews: GithubManualReview[]): Promise<ApplyGithubReviewsResult> {
	const fetchedAt = new Date().toISOString();
	const source = await upsertSourceByOriginUrl({
		name: GITHUB_SOURCE_NAME,
		type: 'github',
		originUrl: GITHUB_SOURCE_ORIGIN_URL,
		metadata: createSourceMetadata(query, fetchedAt, reviews.length),
	});
	// システムプロンプト自体はOpenAIレビューと同一のもの（ai-review-prompt.mjsのbuildSystemPrompt）を
	// サブエージェントへの指示に使うため、prompt_hashも同じ関数で計算し比較可能にする。
	const promptHash = await computePromptHash(topic, DEFAULT_KIND);

	const pendingTagEntries: ItemTagSyncEntry[] = [];
	const items: ImportItemOutcome[] = [];

	for (const entry of reviews) {
		const metadata = {
			service: 'github',
			github: {
				id: entry.repoId,
				stargazers_count: entry.stargazersCount,
				forks_count: entry.forksCount,
				is_fork: false,
				primary_language: entry.primaryLanguage,
				topics: entry.topics,
				archived: entry.archived,
				pushed_at: entry.pushedAt,
			},
			provenance: {
				source: 'github-importer-manual-backfill',
				query,
				fetched_at: fetchedAt,
				repo_id: entry.repoId,
			},
			ai: {
				model: GITHUB_MANUAL_SESSION_REVIEW_MODEL,
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
				publishedAt: entry.createdAt,
				updatedAt: entry.pushedAt,
				metadata,
				version: entry.version,
				collectionRoute: 'github-importer',
				body: truncateBodyForStorage(entry.readmeExcerpt),
				aiAccepted: entry.accepted,
				language: entry.language,
				aiRecheckModel: GITHUB_MANUAL_SESSION_REVIEW_MODEL,
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
