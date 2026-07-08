// 収集ジョブ失敗などの運用アラートを Webhook へ送る。
// ALERT_WEBHOOK_URL が未設定なら何もしない（ローカル開発や通知不要な環境をそのまま許容する）。
// Discord の Webhook は {content}、Slack Incoming Webhook は {text} を要求するため URL で出し分ける。
import { topic } from '../config/topic.config.mjs';

export interface AlertEnv {
	ALERT_WEBHOOK_URL?: string;
}

async function postToWebhook(env: AlertEnv, message: string): Promise<void> {
	const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
	if (!webhookUrl) return;

	const isDiscord = webhookUrl.includes('discord.com/api/webhooks');
	const payload = isDiscord ? { content: message } : { text: message };

	try {
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			console.error('[notify] webhook returned non-OK status', response.status);
		}
	} catch (notifyError) {
		// 通知自体の失敗でジョブの後始末を壊さない。ログにだけ残す。
		console.error('[notify] failed to send alert', notifyError);
	}
}

export async function sendOperationalAlert(env: AlertEnv, title: string, error: unknown): Promise<void> {
	const detail = error instanceof Error ? `${error.message}` : String(error);
	await postToWebhook(env, `⚠️ [${topic.site.slug}] ${title}\n${detail.slice(0, 1500)}`);
}

// エラーではない定期レポート（週次DBレビューなど）用。⚠️ではなく📋を付け、アラートと区別する。
export async function sendMaintenanceReport(env: AlertEnv, title: string, body: string): Promise<void> {
	await postToWebhook(env, `📋 [${topic.site.slug}] ${title}\n${body.slice(0, 1500)}`);
}

export interface NewItemDigestEntry {
	title: string;
	externalUrl: string;
	summary?: string;
	tags?: string[];
}

const X_DRAFT_SUMMARY_MAX_CHARS = 80;
const X_DRAFT_HASHTAG_COUNT = 3;

// AIレビューが生成した summary/tags から、そのままXに貼れる下書きを組み立てる。
// タグは #付きの見出し語に丸めるだけで、記号除去などの厳密なハッシュタグ検証はしない
// （下書きなので投稿前の手直しは前提）。
function buildXPostDraft(item: NewItemDigestEntry): string {
	const summary = item.summary ? item.summary.slice(0, X_DRAFT_SUMMARY_MAX_CHARS) : '';
	const hashtags = (item.tags ?? [])
		.slice(0, X_DRAFT_HASHTAG_COUNT)
		.map((tag) => `#${tag.replace(/[\s#]/g, '')}`)
		.filter((tag) => tag.length > 1)
		.join(' ');
	return [item.title, summary, item.externalUrl, hashtags].filter(Boolean).join('\n');
}

// 収集ジョブで新規に採用された記事を、Xに投稿しやすい下書き文にまとめてDiscordへ送る。
export async function sendNewItemsDigest(env: AlertEnv, jobLabel: string, items: NewItemDigestEntry[]): Promise<void> {
	if (items.length === 0) return;
	const drafts = items.map((item, index) => `${index + 1}. ${buildXPostDraft(item)}`).join('\n\n');
	await postToWebhook(env, `🆕 [${topic.site.slug}] ${jobLabel}で新着 ${items.length} 件\n\n${drafts.slice(0, 1500)}`);
}
