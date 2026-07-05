// Astro の fetch ハンドラに Cron Trigger 用の scheduled ハンドラを足すためのカスタム Worker エントリ。
// wrangler.jsonc の "main" をこのファイルに向けている。
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';

import { sendOperationalAlert } from './lib/notify';
import { resolveBlogSyncOptions, syncBlogCollection } from './lib/importers/blog';
import { resolveNoteSyncOptions, syncNoteCollection } from './lib/importers/note';
import { resolveQiitaSyncOptions, syncQiitaCollection } from './lib/importers/qiita';
import { resolveZennSyncOptions, syncZennCollection } from './lib/importers/zenn';

// wrangler.jsonc の triggers.crons と対応させ、どちらの収集ジョブを起動するか振り分ける。
const ZENN_CRON = '30 21 * * *';
const NOTE_CRON = '0 22 * * *';
const BLOG_CRON = '30 22 * * *';

export default {
	async fetch(request, ctxEnv, ctx) {
		return handle(request, ctxEnv, ctx);
	},
	async scheduled(controller, _ctxEnv, ctx) {
		if (controller.cron === ZENN_CRON) {
			ctx.waitUntil(runScheduledZennImport());
		} else if (controller.cron === NOTE_CRON) {
			ctx.waitUntil(runScheduledNoteImport());
		} else if (controller.cron === BLOG_CRON) {
			ctx.waitUntil(runScheduledBlogImport());
		} else {
			ctx.waitUntil(runScheduledQiitaImport());
		}
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
		// ログは Workers 内にしか残らず誰も気づけないため、Webhook にも通知する。
		await sendOperationalAlert(env, 'Qiita 収集ジョブが失敗しました', error);
	}
}

async function runScheduledZennImport(): Promise<void> {
	// Qiita 同様、記事単位の失敗は syncZennCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/zenn を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await syncZennCollection(resolveZennSyncOptions(env));
		console.log('[cron:zenn] sync completed', {
			topic: result.topic,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
	} catch (error) {
		console.error('[cron:zenn] sync failed', error);
		await sendOperationalAlert(env, 'Zenn 収集ジョブが失敗しました', error);
	}
}

async function runScheduledNoteImport(): Promise<void> {
	// Qiita/Zenn 同様、記事単位の失敗は syncNoteCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/note を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await syncNoteCollection(resolveNoteSyncOptions(env));
		console.log('[cron:note] sync completed', {
			query: result.query,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
	} catch (error) {
		console.error('[cron:note] sync failed', error);
		await sendOperationalAlert(env, 'note 収集ジョブが失敗しました', error);
	}
}

async function runScheduledBlogImport(): Promise<void> {
	// 他インポーター同様、記事単位の失敗は syncBlogCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/blog を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await syncBlogCollection(resolveBlogSyncOptions(env));
		console.log('[cron:blog] sync completed', {
			queries: result.queries,
			pages: result.pages,
			requestsUsed: result.requestsUsed,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
	} catch (error) {
		console.error('[cron:blog] sync failed', error);
		await sendOperationalAlert(env, 'ブログ（Brave Search）収集ジョブが失敗しました', error);
	}
}
