// Astro の fetch ハンドラに Cron Trigger 用の scheduled ハンドラを足すためのカスタム Worker エントリ。
// wrangler.jsonc の "main" をこのファイルに向けている。
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';

import { type DailySourceBreakdown, sendDailyDigest, sendMaintenanceReport, sendOperationalAlert } from './lib/notify';
import { fetchItemSourceNames, type ImportItemOutcome } from './lib/importers/common';
import { runAndRecord } from './lib/import-runs';
import { resolveArxivSyncOptions, syncArxivCollection } from './lib/importers/arxiv';
import { resolveBlogSyncOptions, syncBlogCollection } from './lib/importers/blog';
import { resolveFeedSyncOptions, syncFeedCollection } from './lib/importers/feed';
import { resolveHatenaSyncOptions, syncHatenaCollection } from './lib/importers/hatena';
import { checkLinks, resolveLinkCheckOptions } from './lib/importers/link-check';
import { resolveQiitaSyncOptions, syncQiitaCollection } from './lib/importers/qiita';
import { resolveZennSyncOptions, syncZennCollection } from './lib/importers/zenn';
import { formatWeeklyReviewMessage, runWeeklyReview } from './lib/maintenance-review';
import { topic } from './config/topic.config.mjs';

// wrangler.jsonc の triggers.crons と対応させ、どちらの収集ジョブを起動するか振り分ける。
const WEEKLY_REVIEW_CRON = '30 20 * * 1';
// 日次収集ジョブ群（Cloudflare アカウントの Cron Trigger 登録数上限＝現行プランで5件のため、
// 個別エントリを確保できない）は "0 0 * * *"（0:00 UTC = JST 09:00）の1回の発火にまとめ、順にawaitして実行する
// （並列実行ではない）。各ジョブは個別に try/catch を持つため、1つが失敗しても後続は実行される。
// note は非公式APIが403 Access deniedを返すようになったため自動実行対象から外している
// （コード・手動起動用API（/api/import/note）は残したまま、cronからの呼び出しのみ停止）。
// フィードポーリングは以前は独立した Cron Trigger エントリだったが、必要なのは
// 「blog/hatenaの当日収集より先に消化する」という順序の担保だけだったため、単一発火の
// 先頭ジョブとして統合し、Cron Trigger エントリを1つ節約した。
// 2026-07-09: 日次通知の集約変更（PR #36）のcron動作確認のため、一時的に "15 1 * * *"
// （1:15 UTC = JST 10:15）に変更中。確認後は '0 0 * * *'（JST 09:00）に戻すこと（wrangler.jsonc も同様）。
const DAILY_CRON = '15 1 * * *';
// 新着記事を生む収集ジョブだけを label 付きで登録する（リンク切れ検出は「新着」の概念が
// ないため対象外とし、runDailyJobsSequentially 内で個別に実行する）。
const DAILY_COLLECTION_JOBS: Array<{ label: string; run: () => Promise<ImportItemOutcome[]> }> = [
	{ label: 'フィード', run: runScheduledFeedImport },
	{ label: 'Qiita', run: runScheduledQiitaImport },
	{ label: 'Zenn', run: runScheduledZennImport },
	{ label: 'ブログ', run: runScheduledBlogImport },
	{ label: 'はてな', run: runScheduledHatenaImport },
	{ label: 'arXiv', run: runScheduledArxivImport },
];

export default {
	async fetch(request, ctxEnv, ctx) {
		return handle(request, ctxEnv, ctx);
	},
	async scheduled(controller, _ctxEnv, ctx) {
		if (controller.cron === WEEKLY_REVIEW_CRON) {
			ctx.waitUntil(runScheduledWeeklyReview());
			return;
		}
		if (controller.cron === DAILY_CRON) {
			ctx.waitUntil(runDailyJobsSequentially());
			return;
		}
		console.error('[cron] unrecognized cron expression', { cron: controller.cron });
	},
} satisfies ExportedHandler<Env>;

// 日次ジョブを1回の scheduled 起動の中で順にawaitする。各ジョブは自身の中で
// try/catch と sendOperationalAlert を完結させているため、ここでは単純に直列実行するだけでよい。
// リンク切れ検出だけは「新着」の概念がないため DAILY_COLLECTION_JOBS に含めず、元の実行順
// （blogの後・はてなの前）を保ったまま個別に呼ぶ。
async function runDailyJobsSequentially(): Promise<void> {
	const allNewItems: Array<ImportItemOutcome & { id: number }> = [];
	const breakdown: DailySourceBreakdown[] = [];

	for (const job of DAILY_COLLECTION_JOBS) {
		const items = await job.run();
		const newItems = items.filter((item): item is ImportItemOutcome & { id: number } => item.action === 'inserted' && item.id !== null);
		breakdown.push({ label: job.label, count: newItems.length });
		allNewItems.push(...newItems);

		if (job.label === 'ブログ') {
			await runScheduledLinkCheck();
		}
	}

	await notifyDailyDigest(allNewItems, breakdown);
}

// 1日分の収集結果（全ソース合計）を、Xに投稿しやすい下書き文と内訳付きで1件のDigestとして
// Discordに知らせる。新規採用（action='inserted'）された記事だけを対象にする（更新・棄却分は
// 新着記事のポスト下書きという用途から外れるため含めない）。合計0件でもcronが正常に実行された
// ことの確認シグナルとして必ず送信する（sendDailyDigest側の仕様）。
async function notifyDailyDigest(newItems: Array<ImportItemOutcome & { id: number }>, breakdown: DailySourceBreakdown[]): Promise<void> {
	// blog/feed/hatena は記事ごとに掲載元（個人ブログ等）が異なるため、保存済みの
	// sources.name を都度引いて「タイトル - ソース」の下書きに反映する。
	const sourceNames = newItems.length > 0 ? await fetchItemSourceNames(newItems.map((item) => item.id)) : new Map<number, string>();
	await sendDailyDigest(
		env,
		newItems.map((item) => ({
			title: item.title,
			externalUrl: item.externalUrl,
			sourceName: sourceNames.get(item.id) ?? topic.site.name,
		})),
		breakdown,
	);
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

async function runScheduledQiitaImport(): Promise<ImportItemOutcome[]> {
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
		return result.items;
	} catch (error) {
		console.error('[cron:qiita] sync failed', error);
		// ログは Workers 内にしか残らず誰も気づけないため、Webhook にも通知する。
		await sendOperationalAlert(env, 'Qiita 収集ジョブが失敗しました', error);
		return [];
	}
}

async function runScheduledZennImport(): Promise<ImportItemOutcome[]> {
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
		return result.items;
	} catch (error) {
		console.error('[cron:zenn] sync failed', error);
		await sendOperationalAlert(env, 'Zenn 収集ジョブが失敗しました', error);
		return [];
	}
}

// note の cron 経由の自動実行ジョブ（runScheduledNoteImport 相当）は、非公式APIが
// 403 Access denied を返すようになったため 2026-07-09 に削除した。src/lib/importers/note.ts と
// POST /api/import/note（src/pages/api/import/note.ts）は変更しておらず、手動起動は引き続き可能。

async function runScheduledBlogImport(): Promise<ImportItemOutcome[]> {
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
		return result.items;
	} catch (error) {
		console.error('[cron:blog] sync failed', error);
		await sendOperationalAlert(env, 'ブログ（Brave Search）収集ジョブが失敗しました', error);
		return [];
	}
}

async function runScheduledFeedImport(): Promise<ImportItemOutcome[]> {
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
		return result.items;
	} catch (error) {
		console.error('[cron:feed] sync failed', error);
		await sendOperationalAlert(env, 'RSSフィード追従収集ジョブが失敗しました', error);
		return [];
	}
}

async function runScheduledHatenaImport(): Promise<ImportItemOutcome[]> {
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
		return result.items;
	} catch (error) {
		console.error('[cron:hatena] sync failed', error);
		await sendOperationalAlert(env, 'はてなブックマーク収集ジョブが失敗しました', error);
		return [];
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

async function runScheduledArxivImport(): Promise<ImportItemOutcome[]> {
	// 他インポーター同様、記事（論文）単位の失敗は syncArxivCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/arxiv を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	try {
		const result = await runAndRecord('arxiv', 'cron', () => syncArxivCollection(resolveArxivSyncOptions(env)));
		console.log('[cron:arxiv] sync completed', {
			query: result.query,
			fetched: result.fetched,
			inserted: result.inserted,
			updated: result.updated,
			skipped: result.skipped,
		});
		return result.items;
	} catch (error) {
		console.error('[cron:arxiv] sync failed', error);
		await sendOperationalAlert(env, 'arXiv 収集ジョブが失敗しました', error);
		return [];
	}
}
