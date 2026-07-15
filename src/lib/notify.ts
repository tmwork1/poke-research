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

	// discordapp.com は Discord の旧ドメイン（現在も有効なWebhook URLとして発行される）。
	const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(webhookUrl);
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

// Supabase(PostgrestError等)や単純なオブジェクトとして投げられたエラーは Error のインスタンスではなく、
// String(error) が "[object Object]" になり詳細が失われるため、message プロパティを優先的に拾い、
// なければ JSON.stringify で内容を残す。
function formatErrorDetail(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === 'object') {
		try {
			return JSON.stringify(error);
		} catch {
			// 循環参照などJSON化できない場合のみフォールバック。
		}
	}
	return String(error);
}

export async function sendOperationalAlert(env: AlertEnv, title: string, error: unknown): Promise<void> {
	const detail = formatErrorDetail(error);
	await postToWebhook(env, `⚠️ [${topic.site.slug}] ${title}\n${detail.slice(0, 1500)}`);
}

// エラーではない定期レポート（週次DBレビューなど）用。⚠️ではなく📋を付け、アラートと区別する。
export async function sendMaintenanceReport(env: AlertEnv, title: string, body: string): Promise<void> {
	await postToWebhook(env, `📋 [${topic.site.slug}] ${title}\n${body.slice(0, 1500)}`);
}

export interface NewItemDigestEntry {
	title: string;
	externalUrl: string;
	/** 記事の掲載元名（sources.name）。Qiita/Zenn/noteは固定、blog/feed/hatenaは記事ごとに異なる。 */
	sourceName: string;
	/** 'article' | 'paper'。ヘッダーの内訳（記事/論文）の集計に使う。 */
	kind: string;
}

// Xは140字制限のため、記事が複数件でも収まるよう要約・ハッシュタグは付けず、
// サイトURL＋各記事のタイトル/URL/掲載元だけの下書きにする（下書きなので投稿前の手直しは前提）。
function buildXPostDraft(items: NewItemDigestEntry[]): string {
	const lines = items.map((item) => `${item.title} - ${item.sourceName}\n${item.externalUrl}`);
	return [`${topic.site.url}/`, ...lines].join('\n\n');
}

// 日次収集（wrangler.jsonc の DAILY_CRON）1回分をまとめて1件のDigestとしてDiscordへ送る。
// ソースごとの個別通知（旧sendNewItemsDigest）だと0件のソースは黙ってしまい、cronが
// 正常に実行されたかどうかが通知だけでは分からなかったため、合計0件でも必ず送信する
// （「cronが動いた」ことの確認シグナルとして機能させる）。
// items は呼び出し側（fetchDailyDigestItems）であらかじめ ai_accepted=true のみに
// 絞り込まれている前提（棄却記事は通知に含めない）。
export async function sendDailyDigest(env: AlertEnv, items: NewItemDigestEntry[], jobDate: Date): Promise<void> {
	const articleCount = items.filter((item) => item.kind !== 'paper').length;
	const paperCount = items.filter((item) => item.kind === 'paper').length;
	// jobDateはUTC基準（呼び出し側の日次ジョブ開始時刻）のため、表示用にJST（UTC+9）へ変換する。
	const jst = new Date(jobDate.getTime() + 9 * 60 * 60 * 1000);
	const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(jst.getUTCDate()).padStart(2, '0');
	const header = `【${topic.site.displayName}】${mm}/${dd} 更新\n記事 ${articleCount} 件 / 論文 ${paperCount} 件`;
	if (items.length === 0) {
		await postToWebhook(env, header);
		return;
	}
	const draft = buildXPostDraft(items);
	await postToWebhook(env, `${header}\n\n${draft.slice(0, 1500)}`);
}
