// OpenAI Chat Completions を呼ぶ複数の機能(記事レビュー、タグ解説など)で共有する設定読み込み。
import { readEnv } from '../config/env';

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';
// 分類・抽出タスクで深い推論は不要なため、既定は最小の reasoning_effort でコストを抑える
// （docs/optimization/openai-production-config-review.md の対応プラン3）。
export const DEFAULT_OPENAI_REASONING_EFFORT = 'minimal';

export interface OpenAIConfig {
	apiKey: string;
	model: string;
	reasoningEffort: string;
}

export function getOpenAIConfig(): OpenAIConfig {
	const apiKey = readEnv('OPENAI_API_KEY');
	const model = readEnv('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
	const reasoningEffort = readEnv('OPENAI_REASONING_EFFORT') || DEFAULT_OPENAI_REASONING_EFFORT;
	return { apiKey, model, reasoningEffort };
}
