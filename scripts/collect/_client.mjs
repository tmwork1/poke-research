// scripts/collect/*.mjs から共通で使う POST ヘルパー。
// ADMIN_USERNAME/ADMIN_PASSWORD が両方設定されていれば Basic 認証ヘッダーを付与する
// （本番の保護されたエンドポイントを叩く GitHub Actions から利用するため）。
// 未設定なら従来通りヘッダー無しで送る（ローカルでの無認証運用との後方互換）。
export async function postImport(url, body, label) {
	const headers = { 'Content-Type': 'application/json' };
	const username = process.env.ADMIN_USERNAME;
	const password = process.env.ADMIN_PASSWORD;
	if (username && password) {
		headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	}

	const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${label} failed (${response.status}): ${text}`);
	}
	console.log(text);
}
