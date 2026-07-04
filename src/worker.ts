// Astro の fetch ハンドラに Cron Trigger 用の scheduled ハンドラを足すためのカスタム Worker エントリ。
// wrangler.jsonc の "main" をこのファイルに向けている。
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';

import { resolveQiitaSyncOptions, syncQiitaCollection } from './lib/importers/qiita';

export default {
	async fetch(request, ctxEnv, ctx) {
		return handle(request, ctxEnv, ctx);
	},
	async scheduled(_controller, _ctxEnv, ctx) {
		ctx.waitUntil(runScheduledQiitaImport());
	},
} satisfies ExportedHandler<Env>;

async function runScheduledQiitaImport(): Promise<void> {
	// 記事単位の失敗は syncQiitaCollection 内で skipped として吸収されるため、
	// ここで catch するのはジョブ全体を止める障害（Qiita API 全断、Supabase 未接続など）のみ。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/qiita を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await syncQiitaCollection(resolveQiitaSyncOptions(env));
		console.log('[cron:qiita] sync completed', {
			query: result.query,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
	} catch (error) {
		console.error('[cron:qiita] sync failed', error);
	}
}
