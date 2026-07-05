// OpenAI Chat Completions を呼ぶ複数の機能(記事レビュー、タグ解説など)で共有する設定読み込み。
import { env } from 'cloudflare:workers';

type EnvRecord = Record<string, string | undefined>;

const runtimeEnv = (globalThis as typeof globalThis & { process?: { env: EnvRecord } }).process?.env ?? {};
const cloudflareEnv = env as unknown as EnvRecord;

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';

export interface OpenAIConfig {
	apiKey: string;
	model: string;
}

export function getOpenAIConfig(): OpenAIConfig {
	// Cloudflare 実行環境とローカル環境の両方から設定を読む。
	const apiKey = cloudflareEnv.OPENAI_API_KEY?.trim() || runtimeEnv.OPENAI_API_KEY?.trim() || '';
	const model = cloudflareEnv.OPENAI_MODEL?.trim() || runtimeEnv.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
	return { apiKey, model };
}
