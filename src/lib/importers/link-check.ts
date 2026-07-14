// 元記事の削除・非公開化（リンク切れ）を検出する定期チェッカー（migrations/016）。
// Qiita/Zenn/note/blog と異なり新規アイテムを取り込むわけではないが、既存の収集パイプライン
// （cron / import_runs への記録 / API 手動起動）と同じ枠組みで運用したいため importers/ に置く。
// 状態遷移・到達性判定そのものは Cloudflare 実行環境に依存しない ../link-status に切り出してあり、
// ここでは対象の選定と DB 更新（I/O）だけを担う。
import { mapWithConcurrency } from './common';
import { decideLinkStatus, probeUrl, type LinkCheckOutcome, type LinkCheckTarget } from '../link-status';
import { getSupabaseClient } from '../supabase';
import { parseOptionalPositiveInteger, parsePositiveInteger } from '../params';

// 収集ジョブ本体（検索語等）と異なり、これらはチェック実行の負荷調整パラメータに過ぎないため
// env 経由の上書きを許容する（keywords.ts のような品質直結の値ではない）。
export interface LinkCheckEnvDefaults {
	LINK_CHECK_BATCH_LIMIT?: string | number;
	LINK_CHECK_CONCURRENCY?: string | number;
	LINK_CHECK_RECHECK_DAYS?: string | number;
	LINK_CHECK_TIMEOUT_MS?: string | number;
}

export interface LinkCheckOptions {
	batchLimit?: number;
	concurrency?: number;
	recheckIntervalDays?: number;
	timeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RECHECK_INTERVAL_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 8_000;
// batchLimitを明示指定しない場合、対象件数から「recheckIntervalDays日で一巡する」件数を
// 自動算出する（下記resolveAdaptiveBatchLimit）。件数が増えても手動でLINK_CHECK_BATCH_LIMITを
// 都度調整せずに済むが、Cloudflareのsubrequest上限（無料/標準プランで50/呼び出し）を
// 超えないよう、この安全上限で頭打ちにする（超えて増える分は一巡にかかる日数が伸びるだけで、
// subrequest超過にはならない）。
// probeUrl（../link-status.ts）はHEADが405/501や失敗を返した場合にGETへフォールバックするため、
// 1件あたり最大2 subrequestを消費する（1件1fetch想定ではない）。2026-07-09時点で40に設定して
// いたが、対象記事数の増加でresolveAdaptiveBatchLimitの算出値が常に40（上限）に張り付くように
// なり、40件×最大2fetch＋前後のDBクエリ数件でsubrequest上限50を超え、cron実行が
// （import_runsへの失敗記録すら書き込めないまま）サイレントに落ちる状態が2026-07-10〜07-14の
// 5日間続いていたことが判明した（本番APIへbatchLimitを変えて直接検証: 25は成功、30以降は
// 失敗し記録も残らない）。GET フォールバックを含めても安全マージンを確保できるよう20へ
// 引き下げる（20件×最大2fetch＋DBクエリ数件で50を十分下回る）。
const SAFE_MAX_BATCH_LIMIT = 20;
const MIN_BATCH_LIMIT = 10;
const BATCH_LIMIT_MARGIN = 5;

export function resolveLinkCheckOptions(
	env: LinkCheckEnvDefaults,
	overrides: LinkCheckOptions = {},
): Required<Omit<LinkCheckOptions, 'batchLimit'>> & { batchLimit?: number } {
	return {
		batchLimit: overrides.batchLimit ?? parseOptionalPositiveInteger(env.LINK_CHECK_BATCH_LIMIT),
		concurrency: parsePositiveInteger(overrides.concurrency, parsePositiveInteger(env.LINK_CHECK_CONCURRENCY, DEFAULT_CONCURRENCY)),
		recheckIntervalDays: parsePositiveInteger(
			overrides.recheckIntervalDays,
			parsePositiveInteger(env.LINK_CHECK_RECHECK_DAYS, DEFAULT_RECHECK_INTERVAL_DAYS),
		),
		timeoutMs: parsePositiveInteger(overrides.timeoutMs, parsePositiveInteger(env.LINK_CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
	};
}

// LINK_CHECK_BATCH_LIMITが未指定の場合に使う既定のbatchLimitを、チェック対象になりうる
// 件数（ai_accepted=trueかつexternal_urlがある件数）から算出する。
async function resolveAdaptiveBatchLimit(
	supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
	recheckIntervalDays: number,
): Promise<number> {
	const { count, error } = await supabase
		.from('items')
		.select('id', { count: 'exact', head: true })
		.not('external_url', 'is', null)
		.eq('ai_accepted', true);
	if (error) throw error;

	const eligibleTotal = count ?? 0;
	const target = Math.ceil(eligibleTotal / recheckIntervalDays) + BATCH_LIMIT_MARGIN;
	return Math.min(Math.max(target, MIN_BATCH_LIMIT), SAFE_MAX_BATCH_LIMIT);
}

export interface LinkCheckItemResult {
	id: number;
	externalUrl: string;
	outcome: LinkCheckOutcome;
}

export interface LinkCheckResult {
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
	checkedAt: string;
	items: LinkCheckItemResult[];
}

export async function checkLinks(options: LinkCheckOptions = {}): Promise<LinkCheckResult> {
	const resolved = resolveLinkCheckOptions({}, options);
	const checkedAt = new Date().toISOString();
	const cutoff = new Date(Date.now() - resolved.recheckIntervalDays * 24 * 60 * 60 * 1000).toISOString();

	const supabase = await getSupabaseClient();
	const batchLimit = resolved.batchLimit ?? (await resolveAdaptiveBatchLimit(supabase, resolved.recheckIntervalDays));

	// 全件を毎回叩くとチェック対象サイトへの負荷や実行時間が無視できないため、
	// 未チェック・チェック間隔を過ぎたものだけを対象にし、古い順にバッチ件数だけ処理する。
	const { data, error } = await supabase
		.from('items')
		.select('id, external_url, link_status, link_broken_since')
		.not('external_url', 'is', null)
		// AIレビューで棄却され一覧から隠れている記事（migrations/018）はリンクチェック対象外にする
		// （非表示記事のチェックは無駄なため）。
		.eq('ai_accepted', true)
		.or(`link_checked_at.is.null,link_checked_at.lt.${cutoff}`)
		.order('link_checked_at', { ascending: true, nullsFirst: true })
		.limit(batchLimit);
	if (error) throw error;

	const targets = (data ?? []) as LinkCheckTarget[];

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	const items: LinkCheckItemResult[] = [];
	// DB更新は1件ずつupdateすると最大batchLimit件分のsubrequestになるため、probe結果をためて
	// 最後に1回のupsertでまとめて反映する（cronのsubrequest数を抑える）。upsertは行の全体像を
	// 送る必要があるため、decision.update が省略したフィールドは target の現在値で補って
	// 意図せずNULL化しないようにする。
	const pendingUpdates: Array<{ id: number; link_status: string | null; link_checked_at: string; link_broken_since: string | null }> = [];

	await mapWithConcurrency(targets, resolved.concurrency, async (target) => {
		const externalUrl = target.external_url ?? '';
		if (!externalUrl) {
			skipped += 1;
			items.push({ id: target.id, externalUrl, outcome: 'skipped' });
			return;
		}

		try {
			const { dead } = await probeUrl(externalUrl, resolved.timeoutMs);
			const decision = decideLinkStatus(target, dead, checkedAt);

			pendingUpdates.push({
				id: target.id,
				link_status: decision.update.link_status ?? target.link_status,
				link_checked_at: decision.update.link_checked_at,
				link_broken_since: decision.update.link_broken_since !== undefined ? decision.update.link_broken_since : target.link_broken_since,
			});

			if (decision.outcome === 'broken') inserted += 1;
			else if (decision.outcome === 'recovered') updated += 1;
			items.push({ id: target.id, externalUrl, outcome: decision.outcome });
		} catch (checkError) {
			// 1件の失敗（fetch失敗）がバッチ全体を止めないよう、ここで吸収する。
			skipped += 1;
			items.push({ id: target.id, externalUrl, outcome: 'skipped' });
			// eslint-disable-next-line no-console
			console.error('[link-check] failed to check item', target.id, checkError);
		}
	});

	if (pendingUpdates.length > 0) {
		const { error: updateError } = await supabase.from('items').upsert(pendingUpdates, { onConflict: 'id' });
		if (updateError) throw updateError;
	}

	return {
		fetched: targets.length,
		inserted,
		updated,
		skipped,
		checkedAt,
		items,
	};
}
