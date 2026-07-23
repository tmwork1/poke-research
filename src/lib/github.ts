// GitHub REST API を呼ぶための最小設定読み込み（openalex.ts と同型）。
// 検索APIは未認証だと10req/min（README取得を含むcore APIは60req/hr）しかなく、
// 候補ごとのREADME取得ですぐ枯渇するため、スコープ不要のPAT（GITHUB_TOKEN）を必須にする。
import { readEnv } from '../config/env';

export const GITHUB_SEARCH_REPOSITORIES_URL = 'https://api.github.com/search/repositories';
export const GITHUB_API_BASE_URL = 'https://api.github.com';

export interface GithubConfig {
	token: string;
}

export function getGithubConfig(): GithubConfig {
	return { token: readEnv('GITHUB_TOKEN') };
}
