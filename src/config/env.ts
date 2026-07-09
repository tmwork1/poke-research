// Cloudflare Workers の env バインディングと process.env（ローカル開発・wrangler dev）の
// 両方から環境変数を読む共通ヘルパー。openai.ts・brave.ts など複数箇所で同じ読み込み処理が
// 必要になるため集約する（cloudflare:workers に依存するため、scripts/ 配下の Node 単体
// スクリプトからは import できない。retag-existing-items.mjs 等と同じ理由）。
import { env } from 'cloudflare:workers';

type EnvRecord = Record<string, string | undefined>;

const runtimeEnv = (globalThis as typeof globalThis & { process?: { env: EnvRecord } }).process?.env ?? {};
const cloudflareEnv = env as unknown as EnvRecord;

export function readEnv(key: string): string {
	return cloudflareEnv[key]?.trim() || runtimeEnv[key]?.trim() || '';
}
