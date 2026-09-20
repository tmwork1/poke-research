// 記事レビューの reasoning_effort 下限の回帰テスト。
// 設定読み込みを差し替えて Cloudflare 依存を避け、API 通信はモックで検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const configModuleUrl = `data:text/javascript,${encodeURIComponent(`
	export const config = { apiKey: 'test-key', model: 'gpt-5-nano', reasoningEffort: 'minimal' };
	export const getOpenAIConfig = () => config;
	export const OPENAI_CHAT_COMPLETIONS_URL = 'https://example.com/chat/completions';
`)}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '../openai' && context.parentURL?.endsWith('/importers/article-ai.ts')) {
			return { url: configModuleUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { reviewImportArticle } = await import('../src/lib/importers/article-ai.ts');
const { config } = await import(configModuleUrl);
hooks.deregister();

describe('reviewImportArticle reasoning_effort', () => {
	for (const kind of [undefined, 'article', 'paper', 'repo']) {
		const minimum = kind === undefined || kind === 'article' ? 'medium' : 'low';
		for (const [configured, expected] of [
			['minimal', minimum],
			['low', minimum],
			['medium', 'medium'],
			['high', 'high'],
			['unknown', 'unknown'],
		]) {
			it(`kind=${kind ?? '未指定'} で ${configured} 設定時は ${expected} を送信する`, async (t) => {
				config.reasoningEffort = configured;
				const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
					assert.equal(JSON.parse(init.body as string).reasoning_effort, expected);
					return new Response(JSON.stringify({
						choices: [{ message: { content: JSON.stringify({
							accepted: true,
							summary: 'ポケモンの技術記事。',
							reason: '技術的な解説を含むため。',
							tags: [],
							language: 'ja',
						}) } }],
					}));
				});
				await reviewImportArticle({
					...(kind === undefined ? {} : { kind }),
					title: 'ポケモンの技術記事',
					url: 'https://example.com/article',
					authors: [],
					sourceTags: [],
					bodyExcerpt: 'ポケモンのデータ分析手法を解説する。',
					query: 'ポケモン',
				});
				assert.equal(fetchMock.mock.callCount(), 1);
			});
		}
	}
});
