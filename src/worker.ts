// Astro の fetch ハンドラに Cron Trigger 用の scheduled ハンドラを足すためのカスタム Worker エントリ。
// wrangler.jsonc の "main" をこのファイルに向けている。
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';

import { sendMaintenanceReport, sendNewItemsDigest, sendOperationalAlert } from './lib/notify';
import type { ImportItemOutcome } from './lib/importers/common';
import { runAndRecord } from './lib/import-runs';
import { resolveBlogSyncOptions, syncBlogCollection } from './lib/importers/blog';
import { resolveFeedSyncOptions, syncFeedCollection } from './lib/importers/feed';
import { resolveHatenaSyncOptions, syncHatenaCollection } from './lib/importers/hatena';
import { checkLinks, resolveLinkCheckOptions } from './lib/importers/link-check';
import { resolveNoteSyncOptions, syncNoteCollection } from './lib/importers/note';
import { resolveQiitaSyncOptions, syncQiitaCollection } from './lib/importers/qiita';
import { resolveZennSyncOptions, syncZennCollection } from './lib/importers/zenn';
import { formatWeeklyReviewMessage, runWeeklyReview } from './lib/maintenance-review';

// wrangler.jsonc の triggers.crons と対応させ、どちらの収集ジョブを起動するか振り分ける。
// Cloudflare アカウントの Cron Trigger 登録数上限（現行プランで5件）に収めるため、日次ジョブ群は
// "*/30 21-23 * * *" の1エントリに集約している。この場合 controller.cron は6つの起動時刻すべてで
// 同一の文字列になるため、controller.scheduledTime（UTC時刻）の時:分で個別ジョブに振り分ける。
const WEEKLY_REVIEW_CRON = '30 20 * * 1';
// feed_subscriptions（migrations/022）を直接ポーリングするジョブは単独の Cron Trigger エントリの
// ため、controller.cron の完全一致だけで判定できる（WEEKLY_REVIEW_CRON と同じ方式）。
const FEED_POLL_CRON = '0 20 * * *';

const DAILY_SLOT_HANDLERS: Record<string, () => Promise<void>> = {
	'21:00': runScheduledQiitaImport,
	'21:30': runScheduledZennImport,
	'22:00': runScheduledNoteImport,
	'22:30': runScheduledBlogImport,
	'23:00': runScheduledLinkCheck,
	'23:30': runScheduledHatenaImport,
};

export default {
	async fetch(request, ctxEnv, ctx) {
		return handle(request, ctxEnv, ctx);
	},
	async scheduled(controller, _ctxEnv, ctx) {
		if (controller.cron === WEEKLY_REVIEW_CRON) {
			ctx.waitUntil(runScheduledWeeklyReview());
			return;
		}
		if (controller.cron === FEED_POLL_CRON) {
			ctx.waitUntil(runScheduledFeedImport());
			return;
		}
		const scheduledAt = new Date(controller.scheduledTime);
		const hh = String(scheduledAt.getUTCHours()).padStart(2, '0');
		const mm = String(scheduledAt.getUTCMinutes()).padStart(2, '0');
		const slotKey = `${hh}:${mm}`;
		const handler = DAILY_SLOT_HANDLERS[slotKey];
		if (handler) {
			ctx.waitUntil(handler());
		} else {
			console.error('[cron] unrecognized scheduled slot', { cron: controller.cron, slotKey });
		}
	},
} satisfies ExportedHandler<Env>;

// 収集ジョブで新規採用（action='inserted'）された記事だけを、Xの下書き付きでDiscordに知らせる。
// 更新・棄却分はここでは通知しない（新着記事のポスト下書きという用途に絞るため）。
async function notifyNewItems(jobLabel: string, items: ImportItemOutcome[]): Promise<void> {
	const newItems = items.filter((item) => item.action === 'inserted');
	if (newItems.length === 0) return;
	await sendNewItemsDigest(env, jobLabel, newItems);
}

async function runScheduledWeeklyReview(): Promise<void> {
	// items/sources の重複候補を検出するだけの読み取り専用ジョブ（DBは書き換えない）。
	// 統合が必要な候補は merge-item.mjs / merge-source.mjs を人手で確認して実行する。
	try {
		const result = await runWeeklyReview();
		const message = formatWeeklyReviewMessage(result);
		console.log('[cron:weekly-review] review completed', {
			itemCandidates: result.itemCandidates.length,
			sourceCandidates: result.sourceCandidates.length,
		});
		await sendMaintenanceReport(env, '週次DBレビュー', message);
	} catch (error) {
		console.error('[cron:weekly-review] review failed', error);
		await sendOperationalAlert(env, '週次DBレビューが失敗しました', error);
	}
}

async function runScheduledQiitaImport(): Promise<void> {
	// 記事単位の失敗は syncQiitaCollection 内で skipped として吸収されるため、
	// ここで catch するのはジョブ全体を止める障害（Qiita API 全断、Supabase 未接続など）のみ。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/qiita を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('qiita', 'cron', () => syncQiitaCollection(resolveQiitaSyncOptions(env)));
		console.log('[cron:qiita] sync completed', {
			query: result.query,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('Qiita', result.items);
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
		const result = await runAndRecord('zenn', 'cron', () => syncZennCollection(resolveZennSyncOptions(env)));
		console.log('[cron:zenn] sync completed', {
			topic: result.topic,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('Zenn', result.items);
	} catch (error) {
		console.error('[cron:zenn] sync failed', error);
		await sendOperationalAlert(env, 'Zenn 収集ジョブが失敗しました', error);
	}
}

async function runScheduledNoteImport(): Promise<void> {
	// Qiita/Zenn 同様、記事単位の失敗は syncNoteCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/note を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('note', 'cron', () => syncNoteCollection(resolveNoteSyncOptions(env)));
		console.log('[cron:note] sync completed', {
			query: result.query,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('note', result.items);
	} catch (error) {
		console.error('[cron:note] sync failed', error);
		await sendOperationalAlert(env, 'note 収集ジョブが失敗しました', error);
	}
}

async function runScheduledBlogImport(): Promise<void> {
	// 他インポーター同様、記事単位の失敗は syncBlogCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/blog を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('blog', 'cron', () => syncBlogCollection(resolveBlogSyncOptions(env)));
		console.log('[cron:blog] sync completed', {
			queries: result.queries,
			pages: result.pages,
			requestsUsed: result.requestsUsed,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('ブログ（Brave Search）', result.items);
	} catch (error) {
		console.error('[cron:blog] sync failed', error);
		await sendOperationalAlert(env, 'ブログ（Brave Search）収集ジョブが失敗しました', error);
	}
}

async function runScheduledFeedImport(): Promise<void> {
	// 他インポーター同様、記事単位の失敗は syncFeedCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/feed を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('feed', 'cron', () => syncFeedCollection(resolveFeedSyncOptions(env)));
		console.log('[cron:feed] sync completed', {
			feedsPolled: result.feedsPolled,
			requestsUsed: result.requestsUsed,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('RSSフィード追従', result.items);
	} catch (error) {
		console.error('[cron:feed] sync failed', error);
		await sendOperationalAlert(env, 'RSSフィード追従収集ジョブが失敗しました', error);
	}
}

async function runScheduledHatenaImport(): Promise<void> {
	// 他インポーター同様、記事単位の失敗は syncHatenaCollection 内で skipped として吸収される。
	// はてなブックマーク検索は全ウェブ横断のため精度が低いことが判明しているが、AIレビューを
	// 安全網として運用する方針（docs/progress/2026-07-07.md 参照）。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/hatena を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('hatena', 'cron', () => syncHatenaCollection(resolveHatenaSyncOptions(env)));
		console.log('[cron:hatena] sync completed', {
			keywords: result.keywords,
			requestsUsed: result.requestsUsed,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		await notifyNewItems('はてなブックマーク', result.items);
	} catch (error) {
		console.error('[cron:hatena] sync failed', error);
		await sendOperationalAlert(env, 'はてなブックマーク収集ジョブが失敗しました', error);
	}
}

async function runScheduledLinkCheck(): Promise<void> {
	// 記事単位の失敗（fetch失敗・DB更新失敗）は checkLinks 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/check-links を手動で叩けば再実行できる
	// （対象の再選定はチェック間隔と link_checked_at に基づくため冪等）。
	try {
		const result = await runAndRecord('link-check', 'cron', () => checkLinks(resolveLinkCheckOptions(env)));
		console.log('[cron:link-check] check completed', {
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
	} catch (error) {
		console.error('[cron:link-check] check failed', error);
		await sendOperationalAlert(env, 'リンク切れ検出ジョブが失敗しました', error);
	}
}
