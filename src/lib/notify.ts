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
