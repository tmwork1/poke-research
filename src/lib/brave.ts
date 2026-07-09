// Brave Search API（Web Search）を呼ぶための最小クライアント。
import { readEnv } from '../config/env';

export const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export interface BraveConfig {
	apiKey: string;
}

export function getBraveConfig(): BraveConfig {
	return { apiKey: readEnv('BRAVE_API_KEY') };
}

export interface BraveWebResult {
	title: string;
	url: string;
	description?: string;
	age?: string;
	page_age?: string;
}

interface BraveWebSearchResponse {
	web?: {
		results?: BraveWebResult[];
	};
}

export async function braveWebSearch(query: string, options: { count?: number; offset?: number } = {}): Promise<BraveWebResult[]> {
	const { apiKey } = getBraveConfig();
	if (!apiKey) {
		// API キーがない場合は、誤った無通信のまま進めず明示的に失敗させる。
		throw new Error('BRAVE_API_KEY is required to search blog articles');
	}

	const url = new URL(BRAVE_WEB_SEARCH_URL);
	url.searchParams.set('q', query);
	url.searchParams.set('count', String(options.count ?? 20));
	url.searchParams.set('offset', String(options.offset ?? 0));
	url.searchParams.set('search_lang', 'jp');
	url.searchParams.set('country', 'JP');

	const response = await fetch(url, {
		headers: {
			'X-Subscription-Token': apiKey,
			Accept: 'application/json',
		},
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Brave Search API request failed (${response.status}): ${detail}`);
	}

	const payload = (await response.json()) as BraveWebSearchResponse;
	return payload.web?.results ?? [];
}
