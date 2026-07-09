// Astro の fetch ハンドラに Cron Trigger 用の scheduled ハンドラを足すためのカスタム Worker エントリ。
// wrangler.jsonc の "main" をこのファイルに向けている。
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';

import { sendDailyDigest, sendMaintenanceReport, sendOperationalAlert } from './lib/notify';
import { fetchDailyDigestItems, type ImportItemOutcome } from './lib/importers/common';
import { runAndRecord } from './lib/import-runs';
import { resolveArxivSyncOptions, syncArxivCollection } from './lib/importers/arxiv';
import { resolveBlogSyncOptions, syncBlogCollection } from './lib/importers/blog';
import { resolveBlogKeywordIndex } from './lib/importers/blog-rotation';
import { resolveFeedSyncOptions, syncFeedCollection } from './lib/importers/feed';
import { resolveHatenaSyncOptions, syncHatenaCollection } from './lib/importers/hatena';
import { BLOG_KEYWORDS } from './lib/importers/keywords';
import { checkLinks, resolveLinkCheckOptions } from './lib/importers/link-check';
import { resolveQiitaSyncOptions, syncQiitaCollection } from './lib/importers/qiita';
import { resolveZennSyncOptions, syncZennCollection } from './lib/importers/zenn';
import { formatWeeklyReviewMessage, runWeeklyReview } from './lib/maintenance-review';
import { topic } from './config/topic.config.mjs';

// wrangler.jsonc の triggers.crons と対応させ、どちらの収集ジョブを起動するか振り分ける。
const WEEKLY_REVIEW_CRON = '30 11 * * 1';
// 日次収集ジョブ群（フィード/Qiita/Zenn/はてな/arXiv/リンク切れ検出/日次まとめ通知の7ジョブ、
// noteは403のため対象外）は、Cloudflare アカウントの Cron Trigger 登録数上限（現行プランで5件）
// のため個別エントリを確保できず、1つの Cron Trigger 文字列 "0,5,10,15,20,25,59 15 * * *"
// （収集5ジョブ・リンク切れ検出は15:00〜15:25 UTCを5分刻み、日次まとめ通知だけは前段ジョブの
// 遅延に対する余裕を限界まで確保するため同じ時内の分の最大値15:59 UTCに離して発火）に
// 束ねている。controller.cron はどのスロットでも
// 同一文字列になるため、controller.scheduledTime の分（UTC）から実行するジョブを判定する
// （DAILY_SLOT_JOBS）。
// 2026-07-09判明の subrequest 上限問題（docs/issue/cron-subrequest-limit.md）以降、
// 差分検知・新着件数上限を導入済みだが、それでも1回のWorker呼び出しに全ジョブを集約すると
// 新着急増日に上限を超えうるため、ジョブごとに別々のWorker呼び出しへ分離した。
// 順序は「記事の無駄な重複ができるだけ少なくなる」ことを狙って決めている。Qiita/Zenn/arXivは
// 固有ドメイン（qiita.com/zenn.dev/arxiv.org）のためジョブ間・他ジョブとの重複はほぼ起きない。
// フィードは購読中の個別ブログを直接ポーリングするため、そのブログの記事URLを最初に確定できる。
// はてなブックマークはWeb横断のブックマーク検索のため、フィードが既に収集済みの同一URLを
// 再発見しやすい。既存URL判定（findExistingExternalUrls）は既に収集済みのURLを早期スキップ
// するため、収集5ジョブの最後にはてなを置くことで、その時点までに他ジョブが収集済みのURLが
// はてなの判定でも無駄なくスキップされる。リンク切れ検出・日次まとめ通知は収集5ジョブの結果に
// 依存する（まとめ通知は当日分の収集結果をDBから集計する）ため、その後段のスロットに置く。
const DAILY_CRON = '0,5,10,15,20,25,59 15 * * *';
// note は非公式APIが403 Access deniedを返すようになったため自動実行対象から外している
// （コード・手動起動用API（/api/import/note）は残したまま、cronからの呼び出しのみ停止）。
//
// リンク切れ検出・日次まとめ通知は、以前は "40 15 * * *" の1つのCron Triggerに統合し、
// Worker呼び出し内で順にawaitするだけの実装にしていた（アカウント全体のCron Trigger登録数
// 上限（5件）を1件節約する目的）。だが両者が同一Worker呼び出しのsubrequest予算（50/呼び出し）
// を分け合う必要があり、その分だけリンク切れ検出の1回あたりチェック件数
// （SAFE_MAX_BATCH_LIMIT、src/lib/importers/link-check.ts）を35に頭打ちにせざるを得なかった。
// リンク切れ確認が扱えるリクエスト数を最大化するため、日次収集ジョブ群と同じ時間分割方式
// （DAILY_SLOT_JOBSへのスロット追加）に変更し、それぞれ独立したWorker呼び出しに分離した
// （安全上限は独立呼び出しに戻したことで40へ復元済み）。
const DAILY_SLOT_JOBS: Array<{ minute: number; label: string; run: (scheduledTime: number) => Promise<unknown> }> = [
	{ minute: 0, label: 'フィード', run: runScheduledFeedImport },
	{ minute: 5, label: 'Qiita', run: runScheduledQiitaImport },
	{ minute: 10, label: 'Zenn', run: runScheduledZennImport },
	{ minute: 15, label: 'arXiv', run: runScheduledArxivImport },
	{ minute: 20, label: 'はてな', run: runScheduledHatenaImport },
	{ minute: 25, label: 'リンク切れ検出', run: runScheduledLinkCheck },
	{ minute: 59, label: '日次まとめ通知', run: runScheduledDailyDigest },
];
// 日次収集ジョブ群のうち、新着記事を生む5ジョブが実際に保存する items.collection_route の値。
// 日次まとめ通知（runScheduledDailyDigest）がDBから当日分を集計する際の絞り込みに使う。
const DAILY_COLLECTION_ROUTES = ['feed-importer', 'qiita-importer', 'zenn-importer', 'arxiv-importer', 'hatena-bookmark-importer'];
// ブログ（Brave Search）は発見段階のキーワード検索が新規/既存の判定より前にかかる固定コストで、
// 差分検知でも削減できない。さらに検索キーワード（BLOG_KEYWORDS）は今後も増減しうるため、
// 「1日に何回・何キーワードずつ」をcron側にハードコードしたくない。そこで専用エントリを
// 1日6回（4時間おき）発火させ、resolveBlogKeywordIndex で発火時刻からキーワードを1つだけ選んで
// 実行する（詳細はsrc/lib/importers/blog-rotation.ts）。キーワード数が変わっても、一巡に要する
// 日数が伸び縮みするだけでコード変更は不要。
const BLOG_CRON = '0 1,5,9,13,17,21 * * *';
// BLOG_CRON の発火間隔（4時間）と一致させる。resolveBlogKeywordIndex の通し番号（tick）が
// 発火のたびにちょうど1ずつ進むようにするための値。
const BLOG_ROTATION_SLOT_MS = 4 * 60 * 60 * 1000;

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
			const minute = new Date(controller.scheduledTime).getUTCMinutes();
			const slot = DAILY_SLOT_JOBS.find((job) => job.minute === minute);
			if (!slot) {
				console.error('[cron] unrecognized daily slot minute', { scheduledTime: controller.scheduledTime, minute });
				return;
			}
			ctx.waitUntil(runDailySlotJob(slot, controller.scheduledTime));
			return;
		}
		if (controller.cron === BLOG_CRON) {
			ctx.waitUntil(runScheduledBlogImport(controller.scheduledTime));
			return;
		}
		console.error('[cron] unrecognized cron expression', { cron: controller.cron });
	},
} satisfies ExportedHandler<Env>;

// 日次収集ジョブの1スロット分を実行する。ジョブ自身が try/catch と sendOperationalAlert を
// 完結させているため、ここでは呼び出すだけでよい。scheduledTime はリンク切れ検出・日次まとめ
// 通知のスロットが必要とするため、収集ジョブ側は引数を無視する形で受け取る。
async function runDailySlotJob(slot: { run: (scheduledTime: number) => Promise<unknown> }, scheduledTime: number): Promise<void> {
	await slot.run(scheduledTime);
}

// DAILY_CRON の分59スロット（runScheduledDailyDigest）から呼ばれる。日次収集ジョブ群
// （DAILY_CRON）がスロットごとに別々のWorker呼び出しに分かれたため、各ジョブの結果をメモリで
// 受け渡せない。全収集スロット・リンク切れ検出（15:00〜15:25 UTC）完了後、前段ジョブの遅延に
// 対する余裕を限界まで確保した発火時刻（15:59 UTC）を利用し、当日 0:00 UTC 以降に作成された
// 対象ジョブの items をDBから直接集計してDiscordへ1件のDigestとして知らせる。合計0件でもcronが
// 正常に実行されたことの確認シグナルとして必ず送信する（sendDailyDigest側の仕様）。
async function runScheduledDailyDigest(scheduledTime: number): Promise<void> {
	try {
		const sinceDate = new Date(scheduledTime);
		sinceDate.setUTCHours(0, 0, 0, 0);
		const rows = await fetchDailyDigestItems(sinceDate.toISOString(), DAILY_COLLECTION_ROUTES);
		await sendDailyDigest(
			env,
			rows.map((row) => ({
				title: row.title,
				externalUrl: row.externalUrl,
				sourceName: row.sourceName ?? topic.site.name,
				kind: row.kind,
			})),
		);
	} catch (error) {
		console.error('[cron:daily-digest] digest failed', error);
		await sendOperationalAlert(env, '日次まとめ通知が失敗しました', error);
	}
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

async function runScheduledBlogImport(scheduledTime: number): Promise<ImportItemOutcome[]> {
	// 他インポーター同様、記事単位の失敗は syncBlogCollection 内で skipped として吸収される。
	// 失敗時は次回 cron 実行を待つか、POST /api/import/blog を手動で叩けば同じ内容を再実行できる（upsert なので冪等）。
	// 発火のたびに全キーワードをまとめて検索すると発見段階だけで固定コストが大きいため
	// （docs/issue/cron-subrequest-limit.md参照）、resolveBlogKeywordIndex で1キーワードだけ選ぶ。
	const keyword = BLOG_KEYWORDS[resolveBlogKeywordIndex(scheduledTime, BLOG_ROTATION_SLOT_MS, BLOG_KEYWORDS.length)];
	try {
		const result = await runAndRecord('blog', 'cron', () => syncBlogCollection(resolveBlogSyncOptions(env, { query: keyword })));
		console.log('[cron:blog] sync completed', {
			keyword,
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

// DAILY_CRON の分25スロットから呼ばれる。日次収集ジョブ群と同じ時間分割の1スロットとして
// 独立したWorker呼び出しになるため、subrequest予算（50/呼び出し）をこのジョブ単体で使い切れる。
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
