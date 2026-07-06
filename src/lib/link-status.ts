// リンク切れ検出（migrations/016）の状態遷移・到達性判定ロジック。
// DB(Supabase)・Cloudflare 実行環境への依存を持たないため、node --test から直接ユニットテストできる
// （src/lib/importers/link-check.ts が DB I/O 部分を担い、ここは判定の中身だけを持つ）。
import { topic } from '../config/topic.config.mjs';

const USER_AGENT = `${topic.site.slug}-link-checker (+${topic.site.url})`;

export type LinkCheckOutcome = 'ok' | 'suspect' | 'broken' | 'recovered' | 'unchanged' | 'skipped';

export interface LinkCheckTarget {
	id: number;
	external_url: string | null;
	link_status: string | null;
	link_broken_since: string | null;
}

export interface LinkStatusUpdate {
	link_status?: 'ok' | 'broken';
	link_checked_at: string;
	link_broken_since?: string | null;
}

export interface LinkStatusDecision {
	outcome: LinkCheckOutcome;
	update: LinkStatusUpdate;
}

// 一時的な障害（回線・サーバー再起動など）で誤って「リンク切れ」表示にしないよう、
// 2回連続の到達不能判定で初めて link_status を 'broken' に確定する。1回目は
// link_broken_since に「疑い開始時刻」を記録するだけに留め、次回のチェックで ok に戻れば
// 疑いを解消する。
export function decideLinkStatus(target: Pick<LinkCheckTarget, 'link_status' | 'link_broken_since'>, dead: boolean, checkedAt: string): LinkStatusDecision {
	const wasBroken = target.link_status === 'broken';
	const hadSuspicion = Boolean(target.link_broken_since);

	if (!dead) {
		if (wasBroken || hadSuspicion) {
			return {
				outcome: 'recovered',
				update: { link_status: 'ok', link_checked_at: checkedAt, link_broken_since: null },
			};
		}
		return { outcome: 'ok', update: { link_checked_at: checkedAt } };
	}

	if (hadSuspicion && !wasBroken) {
		// 前回も疑いがあり、今回も到達不能 → 確定して broken にする。
		return { outcome: 'broken', update: { link_status: 'broken', link_checked_at: checkedAt } };
	}

	if (wasBroken) {
		// 既に broken 確定済み。定点観測のため checked_at のみ更新する。
		return { outcome: 'unchanged', update: { link_checked_at: checkedAt } };
	}

	// 初回の疑い。次回も到達不能なら broken に確定する。
	return { outcome: 'suspect', update: { link_checked_at: checkedAt, link_broken_since: checkedAt } };
}

function isDeadStatus(status: number | null): boolean {
	return status === 404 || status === 410;
}

export async function probeUrl(url: string, timeoutMs: number): Promise<{ dead: boolean; status: number | null }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// まず HEAD で軽量に確認し、ブログホストによっては HEAD を拒否/未対応（405/501）なことが
		// あるため、その場合だけ GET にフォールバックする。
		const headResponse = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: controller.signal,
			headers: { 'User-Agent': USER_AGENT },
		}).catch(() => null);

		if (headResponse && headResponse.status !== 405 && headResponse.status !== 501) {
			return { dead: isDeadStatus(headResponse.status), status: headResponse.status };
		}

		const getResponse = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			signal: controller.signal,
			headers: { 'User-Agent': USER_AGENT },
		});
		return { dead: isDeadStatus(getResponse.status), status: getResponse.status };
	} catch {
		// DNS解決失敗・接続不可などは、ドメインごと消えた可能性が高いシグナルとして扱う。
		return { dead: true, status: null };
	} finally {
		clearTimeout(timeout);
	}
}
