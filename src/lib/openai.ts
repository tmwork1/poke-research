// OpenAI Chat Completions を呼ぶ複数の機能(記事レビュー、タグ解説など)で共有する設定読み込み。
import { readEnv } from '../config/env';

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';

export interface OpenAIConfig {
	apiKey: string;
	model: string;
}

export function getOpenAIConfig(): OpenAIConfig {
	const apiKey = readEnv('OPENAI_API_KEY');
	const model = readEnv('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
	return { apiKey, model };
}
