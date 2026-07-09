// OpenAlex Works API を呼ぶための最小設定読み込み（brave.ts と同型）。
// OpenAlexは無料キーで1日$1相当（フィルタ検索1万コール/検索1000コール等）を利用できるが、
// キー自体は無料でも必須のため、Brave Search・OpenAIと同様に環境変数から読む。
import { readEnv } from '../config/env';

export const OPENALEX_API_URL = 'https://api.openalex.org/works';

export interface OpenAlexConfig {
	apiKey: string;
}

export function getOpenAlexConfig(): OpenAlexConfig {
	return { apiKey: readEnv('OPENALEX_API_KEY') };
}
