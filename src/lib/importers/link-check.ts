// 元記事の削除・非公開化（リンク切れ）を検出する定期チェッカー（migrations/016）。
// Qiita/Zenn/note/blog と異なり新規アイテムを取り込むわけではないが、既存の収集パイプライン
// （cron / import_runs への記録 / API 手動起動）と同じ枠組みで運用したいため importers/ に置く。
// 状態遷移・到達性判定そのものは Cloudflare 実行環境に依存しない ../link-status に切り出してあり、
// ここでは対象の選定と DB 更新（I/O）だけを担う。
import { mapWithConcurrency } from './common';
import { decideLinkStatus, probeUrl, type LinkCheckOutcome, type LinkCheckTarget } from '../link-status';
import { getSupabaseClient } from '../supabase';
import { parsePositiveInteger } from '../params';

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

const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RECHECK_INTERVAL_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 8_000;

export function resolveLinkCheckOptions(env: LinkCheckEnvDefaults, overrides: LinkCheckOptions = {}): Required<LinkCheckOptions> {
	return {
		batchLimit: parsePositiveInteger(overrides.batchLimit, parsePositiveInteger(env.LINK_CHECK_BATCH_LIMIT, DEFAULT_BATCH_LIMIT)),
		concurrency: parsePositiveInteger(overrides.concurrency, parsePositiveInteger(env.LINK_CHECK_CONCURRENCY, DEFAULT_CONCURRENCY)),
		recheckIntervalDays: parsePositiveInteger(
			overrides.recheckIntervalDays,
			parsePositiveInteger(env.LINK_CHECK_RECHECK_DAYS, DEFAULT_RECHECK_INTERVAL_DAYS),
		),
		timeoutMs: parsePositiveInteger(overrides.timeoutMs, parsePositiveInteger(env.LINK_CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
	};
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
	// 全件を毎回叩くとチェック対象サイトへの負荷や実行時間が無視できないため、
	// 未チェック・チェック間隔を過ぎたものだけを対象にし、古い順にバッチ件数だけ処理する。
	const { data, error } = await supabase
		.from('items')
		.select('id, external_url, link_status, link_broken_since')
		.not('external_url', 'is', null)
		.or(`link_checked_at.is.null,link_checked_at.lt.${cutoff}`)
		.order('link_checked_at', { ascending: true, nullsFirst: true })
		.limit(resolved.batchLimit);
	if (error) throw error;

	const targets = (data ?? []) as LinkCheckTarget[];

	let inserted = 0;
	let updated = 0;
	let skipped = 0;
	const items: LinkCheckItemResult[] = [];

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

			const { error: updateError } = await supabase.from('items').update(decision.update).eq('id', target.id);
			if (updateError) throw updateError;

			if (decision.outcome === 'broken') inserted += 1;
			else if (decision.outcome === 'recovered') updated += 1;
			items.push({ id: target.id, externalUrl, outcome: decision.outcome });
		} catch (checkError) {
			// 1件の失敗（fetch失敗・DB更新失敗）がバッチ全体を止めないよう、ここで吸収する。
			skipped += 1;
			items.push({ id: target.id, externalUrl, outcome: 'skipped' });
			// eslint-disable-next-line no-console
			console.error('[link-check] failed to check item', target.id, checkError);
		}
	});

	return {
		fetched: targets.length,
		inserted,
		updated,
		skipped,
		checkedAt,
		items,
	};
}
