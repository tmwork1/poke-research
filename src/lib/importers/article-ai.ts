// 記事取り込み前に OpenAI へレビューを依頼し、採用可否と要約・タグを作る。
// JSON 形式の応答を前提にして、後続の DB 保存処理を安定させる。
import { getOpenAIConfig, OPENAI_CHAT_COMPLETIONS_URL } from '../openai';

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
	tagLabels: Record<string, string>;
	reason: string;
	confidence?: number;
	model: string;
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

function createOpenAIRequest(input: ImportArticleReviewInput, model: string) {
	// レスポンスは JSON 固定にして、後続のパースを安定させる。
	return {
		model,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content:
					'あなたは記事収集前レビュー担当です。このハブはポケモンのプログラミング・開発に関する技術情報（ツール、API、データ解析、対戦・育成支援、ROMハック、ファンゲーム開発などの実装や手法を扱う記事）だけを収集対象とします。判定は次の2条件を順に確認し、両方を満たす場合のみ accepted を true にしてください。(1) 記事の主題がポケモン（ゲーム本編、カードゲーム、関連データ・API・ファンコンテンツなど）に直接関係していること。ポケモンへの言及が全く無い記事や、一般的な技術記事の中でポケモンが一例・比喩として軽く触れられているだけで記事の主眼がポケモンではない記事は、技術的に優れていても accepted を false にしてください。一方、ポケモンのデータや仕組み（図鑑、進化、育成、対戦、カードなど）を実装・設計の題材として一貫して扱っている記事（例: ポケモンのデータ構造をクラス設計で学ぶ教材、ポケモンを例にしたオントロジー設計）は、一般的な技術を学ぶ目的であっても主題をポケモン関連とみなしてください。(2) 主題がポケモン関連であっても、体験談・エッセイ・創作小説・ニュース・商品紹介・ファン活動など技術的な実装や手法を扱わない記事は accepted を false にしてください。出力はJSONオブジェクトのみで、accepted/summary/tags/reason/confidence を含めてください。summary は日本語の要約で、だ・である調または体言止めの常体を使い、2文以内・全体で120字程度に収めてください（ですます調や「〜について解説しています」のような冗長な言い回しは使わないでください）。reason は判定理由（上記のどちらの条件で判断したかが分かるように）を簡潔に書いてください。tags は検索や絞り込みに役立つ具体的なタグを3〜5個選んでください。次の2点を必ず守ってください。(a) 「システム開発」「設計パターン」「プログラミング」「技術記事」「開発」「実装」のように、ほぼ全ての技術記事に当てはまり、そのタグ単体で検索すると無関係な記事まで大量にヒットしてしまう一般語は使わず、記事で実際に使われている技術要素（具体的な言語・フレームワーク・ライブラリ・アルゴリズム・手法名。「設計パターン」ではなく実際に登場する具体的なパターン名や技術名）と、記事が扱うポケモン側の具体的対象（カードゲーム、ROM改造、対戦・育成、図鑑データなど記事内容に応じたもの）を優先してください。(b) 新しいタグを作る前に必ず existing_tags を確認し、同義・類似の概念や綴りが非常に近い語があれば新しい表記を作らず existing_tags の表記をそのまま使ってください。特にカタカナ語の濁点・半濁点の打ち間違いに注意し（正しい表記は「ポケモンカード」であり「ポケモンカート」ではありません）、綴りに自信が持てない場合は不確かな新規タグを作らないでください。このハブの記事は全てポケモン関連であることが前提のため、「ポケモン」「pokemon」など主題そのものを指すだけのタグは付けないでください。',
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
	const { tags, tagLabels } = Array.isArray(parsed.tags)
		? normalizeAiTags(parsed.tags.filter((tag): tag is string => typeof tag === 'string'))
		: { tags: [], tagLabels: {} };
	const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

	if (!summary) throw new Error('OpenAI response missing summary');
	if (!reason) throw new Error('OpenAI response missing reason');

	return {
		accepted,
		summary,
		tags,
		tagLabels,
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