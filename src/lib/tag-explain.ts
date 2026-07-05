// タグ名が専門用語かどうかをAIに判定させ、難しい場合だけ短い解説を生成する。
// 一度生成した結果は tags テーブルにキャッシュし、以降は再判定しない。
import { getSupabaseClient } from './supabase';
import { getOpenAIConfig, OPENAI_CHAT_COMPLETIONS_URL } from './openai';

export interface TagExplanation {
	isDifficult: boolean;
	explanation: string | null;
}

interface TagExplanationRow {
	is_difficult: boolean | null;
	explanation: string | null;
	explained_at: string | null;
}

function createOpenAIRequest(tagName: string, model: string) {
	return {
		model,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content:
					'あなたはポケモンプログラミング情報ハブの用語解説アシスタントです。入力されたタグ名が、プログラミング初心者や一般読者にとって説明なしでは理解しづらい専門用語かどうかを判定してください。専門用語であれば、日本語で1〜2文の平易な解説を書いてください。専門用語でなければ explanation は null にしてください。出力はJSONオブジェクトのみで、is_difficult(boolean)とexplanation(string|null)を含めてください。',
			},
			{
				role: 'user',
				content: JSON.stringify({ tag: tagName }),
			},
		],
	};
}

function parseOpenAIResponse(content: string): TagExplanation {
	const trimmed = content.trim();
	const normalized = trimmed
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/```\s*$/i, '');
	const parsed = JSON.parse(normalized) as Partial<{ is_difficult: boolean; explanation: string | null }>;
	if (typeof parsed.is_difficult !== 'boolean') {
		throw new Error('OpenAI response missing is_difficult flag');
	}
	const explanation = typeof parsed.explanation === 'string' ? parsed.explanation.trim() : null;
	return {
		isDifficult: parsed.is_difficult,
		explanation: parsed.is_difficult && explanation ? explanation : null,
	};
}

export async function explainTag(tagId: number, tagName: string): Promise<TagExplanation> {
	const supabase = await getSupabaseClient();

	const { data: existing, error: fetchError } = await supabase
		.from('tags')
		.select('is_difficult, explanation, explained_at')
		.eq('id', tagId)
		.maybeSingle();
	if (fetchError) throw fetchError;

	const row = existing as TagExplanationRow | null;
	if (row?.explained_at) {
		return { isDifficult: Boolean(row.is_difficult), explanation: row.explanation ?? null };
	}

	const { apiKey, model } = getOpenAIConfig();
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is required to explain tags');
	}

	const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(createOpenAIRequest(tagName, model)),
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

	const result = parseOpenAIResponse(content);

	const { error: updateError } = await supabase
		.from('tags')
		.update({
			is_difficult: result.isDifficult,
			explanation: result.explanation,
			explained_at: new Date().toISOString(),
		})
		.eq('id', tagId);
	if (updateError) throw updateError;

	return result;
}
