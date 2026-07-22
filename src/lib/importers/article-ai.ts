// 記事取り込み前に OpenAI へレビューを依頼し、採用可否と要約・タグを作る。
// JSON 形式の応答を前提にして、後続の DB 保存処理を安定させる。
import { getOpenAIConfig, OPENAI_CHAT_COMPLETIONS_URL } from '../openai';
import { topic } from '../../config/topic.config.mjs';
import { buildSystemPrompt, computePromptHash } from './ai-review-prompt.mjs';

const MAX_AI_TAGS = 5;

// reasoning_effort の序列（値が後ろにあるほど推論コストが高い）。
const REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'];
// kind='repo'（GitHubリポジトリのREADMEレビュー）は、reasoning_effort=minimal（既定値）だと
// 言語判定・主題判定を安定してこなせず、5件中0件採用・JSON不備エラーが多発することを実験で確認した
// （docs/optimization/github-repo-filter-accuracy.md 実験1〜4）。プロンプト文言の問題ではなく
// 推論コスト不足が原因だったため、article/paperの既定値・課金には影響させず repo のみ底上げする。
const MIN_REASONING_EFFORT_BY_KIND: Record<string, string> = { repo: 'low' };

function resolveReasoningEffort(kind: string | undefined, configured: string): string {
	const minimum = kind ? MIN_REASONING_EFFORT_BY_KIND[kind] : undefined;
	if (!minimum) return configured;
	const configuredRank = REASONING_EFFORT_ORDER.indexOf(configured);
	const minimumRank = REASONING_EFFORT_ORDER.indexOf(minimum);
	// 未知の値（将来の新しいreasoning_effort値など）はそのまま尊重し、底上げしない。
	if (configuredRank === -1 || minimumRank === -1) return configured;
	return configuredRank >= minimumRank ? configured : minimum;
}

export interface ImportArticleReviewInput {
	title: string;
	url: string;
	authors: string[];
	sourceTags: string[];
	bodyExcerpt: string;
	query: string;
	createdAt?: string;
	updatedAt?: string;
	sourceName?: string;
	existingTags?: string[];
	/** items.kind に対応する種別（既定 'article'）。'paper' は arXiv 収集（arxiv.ts）、'repo' は GitHub リポジトリ収集（github.ts）が渡す。 */
	kind?: string;
}

export interface ImportArticleReview {
	accepted: boolean;
	summary: string;
	tags: string[];
	tagLabels: Record<string, string>;
	reason: string;
	confidence?: number;
	/** AIが判定した記事本文の主な言語（ISO 639-1の小文字コード。migrations/021）。 */
	language: string;
	model: string;
	/** レビュー時点の system prompt のハッシュ（migrations/025、ai-review-prompt.mjs の computePromptHash）。 */
	promptHash: string;
}

export function normalizeTagName(tagName: string): string {
	// 大文字小文字違い（AI/ai）やアクセント記号違い（Pokédex/pokedex）のタグが
	// 別タグとして重複しないよう、小文字・アクセント除去に統一する。
	// NFKDは日本語の濁点・半濁点（ポ→ホ+゚など）も分解するため、除去対象外の
	// 結合文字はNFCで再合成し、分解済み表記のタグが別レコードとして増えないようにする。
	const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');
	return tagName
		.trim()
		.replace(/\s+/g, ' ')
		.normalize('NFKD')
		.replace(COMBINING_DIACRITICS, '')
		.normalize('NFC')
		.toLowerCase();
}

export function buildTagLabels(rawTags: string[]): Record<string, string> {
	// タグ新規作成時の表示用表記として、正規化前（AIや収集元がそのまま返した）表記を残す。
	// 同じ正規化名に複数の表記が来た場合は最初に見つかったものを使う。
	const labels: Record<string, string> = {};
	for (const raw of rawTags) {
		const trimmed = raw.trim().replace(/\s+/g, ' ');
		if (!trimmed) continue;
		const normalized = normalizeTagName(trimmed);
		if (!normalized || labels[normalized]) continue;
		labels[normalized] = trimmed;
	}
	return labels;
}

function normalizeAiTags(tags: string[]): { tags: string[]; tagLabels: Record<string, string> } {
	// 余計な空白や重複を落として、保存時のタグ表記を揃える。
	const normalized = [...new Set(tags.map(normalizeTagName).filter((tag) => tag.length > 0))].slice(0, MAX_AI_TAGS);
	const tagLabels = buildTagLabels(tags);
	for (const key of Object.keys(tagLabels)) {
		if (!normalized.includes(key)) delete tagLabels[key];
	}
	return { tags: normalized, tagLabels };
}

function createOpenAIRequest(input: ImportArticleReviewInput, model: string, reasoningEffort: string) {
	// レスポンスは JSON 固定にして、後続のパースを安定させる。
	return {
		model,
		reasoning_effort: reasoningEffort,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: buildSystemPrompt(topic, input.kind),
			},
			{
				role: 'user',
				// インデント整形はトークンの無駄になるだけでモデルの理解には寄与しないため、コンパクトなJSONで送る。
				content: JSON.stringify({
					source_name: input.sourceName,
					query: input.query,
					title: input.title,
					url: input.url,
					authors: input.authors,
					source_tags: input.sourceTags,
					existing_tags: input.existingTags ?? [],
					created_at: input.createdAt,
					updated_at: input.updatedAt,
					body_excerpt: input.bodyExcerpt,
				}),
			},
		],
	};
}

function parseAiResponse(content: string): Omit<ImportArticleReview, 'model' | 'promptHash'> {
	// 返答にコードフェンスが混ざっても読めるように、先に包みを外す。
	const trimmed = content.trim();
	const normalized = trimmed
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/```\s*$/i, '');
	const parsed = JSON.parse(normalized) as Partial<ImportArticleReview> & { accepted?: boolean; accept?: boolean; reason?: string };
	// 古い応答形式の accept も吸収して、移行中でも壊れないようにする。
	let accepted = typeof parsed.accepted === 'boolean' ? parsed.accepted : parsed.accept;
	if (typeof accepted !== 'boolean') {
		throw new Error('OpenAI response missing accepted flag');
	}

	const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
	let reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
	const language = typeof parsed.language === 'string' ? parsed.language.trim().toLowerCase() : '';

	// ai-review-prompt.mjs の STEP 1・STEP 2 は「以降のSTEPに関わらず accepted を false にする」と
	// 指示した上でreasonにこの文言を書かせている。accepted=true と矛盾する応答が来た場合は
	// STEP側の判定を優先して強制的に false へ倒す（過去に reason へ「ツールの提供ページ」等と
	// 棄却理由を書きながら accepted=true を返す事例があった、docs/optimization/openai-production-config-review.md）。
	const REJECT_CONTRADICTION_PATTERNS = [/対象言語外/, /リンク集・目次ページ/];
	if (accepted && REJECT_CONTRADICTION_PATTERNS.some((pattern) => pattern.test(reason))) {
		accepted = false;
		reason = `[reasonとacceptedの矛盾を検知したため自動棄却] ${reason}`;
	}
	const { tags, tagLabels } = Array.isArray(parsed.tags)
		? normalizeAiTags(parsed.tags.filter((tag): tag is string => typeof tag === 'string'))
		: { tags: [], tagLabels: {} };
	const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

	if (!summary) throw new Error('OpenAI response missing summary');
	if (!reason) throw new Error('OpenAI response missing reason');
	if (!language) throw new Error('OpenAI response missing language');

	return {
		accepted,
		summary,
		tags,
		tagLabels,
		reason,
		confidence,
		language,
	};
}

export async function reviewImportArticle(input: ImportArticleReviewInput): Promise<ImportArticleReview> {
	const { apiKey, model, reasoningEffort: configuredReasoningEffort } = getOpenAIConfig();
	if (!apiKey) {
		// API キーがない場合は、誤った無通信のまま進めず明示的に失敗させる。
		throw new Error('OPENAI_API_KEY is required to review imported articles');
	}

	const reasoningEffort = resolveReasoningEffort(input.kind, configuredReasoningEffort);
	const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(createOpenAIRequest(input, model, reasoningEffort)),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
	}

	const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
	const content = payload.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error('OpenAI response did not include message content');
	}

	const review = parseAiResponse(content);
	const promptHash = await computePromptHash(topic, input.kind);
	return {
		...review,
		model,
		promptHash,
	};
}