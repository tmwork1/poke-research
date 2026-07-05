// 記事取り込み前に OpenAI へレビューを依頼し、採用可否と要約・タグを作る。
// JSON 形式の応答を前提にして、後続の DB 保存処理を安定させる。
import { env } from 'cloudflare:workers';

type EnvRecord = Record<string, string | undefined>;

const runtimeEnv = (globalThis as typeof globalThis & { process?: { env: EnvRecord } }).process?.env ?? {};
const cloudflareEnv = env as unknown as EnvRecord;

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';
const MAX_AI_TAGS = 5;

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
}

export interface ImportArticleReview {
	accepted: boolean;
	summary: string;
	tags: string[];
	reason: string;
	confidence?: number;
	model: string;
}

interface OpenAIConfig {
	apiKey: string;
	model: string;
}

export function normalizeTagName(tagName: string): string {
	// 大文字小文字違い（AI/ai）やアクセント記号違い（Pokédex/pokedex）のタグが
	// 別タグとして重複しないよう、小文字・アクセント除去に統一する。
	const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');
	return tagName
		.trim()
		.replace(/\s+/g, ' ')
		.normalize('NFKD')
		.replace(COMBINING_DIACRITICS, '')
		.toLowerCase();
}

function normalizeAiTags(tags: string[]): string[] {
	// 余計な空白や重複を落として、保存時のタグ表記を揃える。
	return [...new Set(tags.map(normalizeTagName).filter((tag) => tag.length > 0))].slice(0, MAX_AI_TAGS);
}

function getOpenAIConfig(): OpenAIConfig {
	// Cloudflare 実行環境とローカル環境の両方から設定を読む。
	const apiKey = cloudflareEnv.OPENAI_API_KEY?.trim() || runtimeEnv.OPENAI_API_KEY?.trim() || '';
	const model = cloudflareEnv.OPENAI_MODEL?.trim() || runtimeEnv.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
	return { apiKey, model };
}

function createOpenAIRequest(input: ImportArticleReviewInput, model: string) {
	// レスポンスは JSON 固定にして、後続のパースを安定させる。
	return {
		model,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content:
					'あなたは記事収集前レビュー担当です。このハブはポケモンのプログラミング・開発に関する技術情報（ツール、API、データ解析、対戦・育成支援、ROMハック、ファンゲーム開発などの実装や手法を扱う記事）だけを収集対象とします。判定は次の2条件を順に確認し、両方を満たす場合のみ accepted を true にしてください。(1) 記事の主題がポケモン（ゲーム本編、カードゲーム、関連データ・API・ファンコンテンツなど）に直接関係していること。ポケモンへの言及が全く無い記事や、一般的な技術記事の中でポケモンが一例・比喩として軽く触れられているだけで記事の主眼がポケモンではない記事は、技術的に優れていても accepted を false にしてください。一方、ポケモンのデータや仕組み（図鑑、進化、育成、対戦、カードなど）を実装・設計の題材として一貫して扱っている記事（例: ポケモンのデータ構造をクラス設計で学ぶ教材、ポケモンを例にしたオントロジー設計）は、一般的な技術を学ぶ目的であっても主題をポケモン関連とみなしてください。(2) 主題がポケモン関連であっても、体験談・エッセイ・創作小説・ニュース・商品紹介・ファン活動など技術的な実装や手法を扱わない記事は accepted を false にしてください。出力はJSONオブジェクトのみで、accepted/summary/tags/reason/confidence を含めてください。summary は日本語で3行以内の要約、tags は検索しやすい分類タグを3〜5個、reason は判定理由（上記のどちらの条件で判断したかが分かるように）を簡潔に書いてください。tags を選ぶ際は、user メッセージの existing_tags に同義・類似の概念があればそれを優先して再利用し、表記ゆれ（大文字小文字、送り仮名、カタカナ/英語表記の違いなど）で新しいタグを増やさないでください。',
			},
			{
				role: 'user',
				content: JSON.stringify(
					{
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
					},
					null,
					2,
				),
			},
		],
	};
}

function parseAiResponse(content: string): Omit<ImportArticleReview, 'model'> {
	// 返答にコードフェンスが混ざっても読めるように、先に包みを外す。
	const trimmed = content.trim();
	const normalized = trimmed
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/```\s*$/i, '');
	const parsed = JSON.parse(normalized) as Partial<ImportArticleReview> & { accepted?: boolean; accept?: boolean; reason?: string };
	// 古い応答形式の accept も吸収して、移行中でも壊れないようにする。
	const accepted = typeof parsed.accepted === 'boolean' ? parsed.accepted : parsed.accept;
	if (typeof accepted !== 'boolean') {
		throw new Error('OpenAI response missing accepted flag');
	}

	const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
	const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
	const tags = Array.isArray(parsed.tags) ? normalizeAiTags(parsed.tags.filter((tag): tag is string => typeof tag === 'string')) : [];
	const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

	if (!summary) throw new Error('OpenAI response missing summary');
	if (!reason) throw new Error('OpenAI response missing reason');

	return {
		accepted,
		summary,
		tags,
		reason,
		confidence,
	};
}

export async function reviewImportArticle(input: ImportArticleReviewInput): Promise<ImportArticleReview> {
	const { apiKey, model } = getOpenAIConfig();
	if (!apiKey) {
		// API キーがない場合は、誤った無通信のまま進めず明示的に失敗させる。
		throw new Error('OPENAI_API_KEY is required to review imported articles');
	}

	const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(createOpenAIRequest(input, model)),
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
	return {
		...review,
		model,
	};
}