// 各収集ルート（qiita/zenn/arxiv/hatena/blog/feed）が実際に消費するCloudflare Workers
// subrequest数を実測するスクリプト。src/middleware.ts の DEBUG_SUBREQUEST_COUNT フラグと
// src/lib/subrequest-counter.ts の計測に対応するため、実行前にローカルの dev server を
// DEBUG_SUBREQUEST_COUNT=1 で起動しておく必要がある。`astro dev`（@astrojs/cloudflare）が
// ローカルで Cloudflare env バインディングを組み立てる際は `.env` ではなく `.dev.vars`
// （wrangler dev 同様のローカル秘匿値ファイル）を読むため、`.dev.vars` に
// `DEBUG_SUBREQUEST_COUNT=1` を一時的に追記してから `astro dev stop && astro dev --background`
// で再起動し、検証後は行を削除しておくこと。
//
// 各ルートに (a) maxNewItemsPerRun未指定（＝コード既定値のまま）で1回、(b) 対象のitemsを
// 事前に1件だけローカルDBから削除したうえでmaxNewItemsPerRun=1を指定して1回、の順でPOSTする。
// (a)は「ローカルDBに新規候補が無い定常状態」での固定コストの実測値、(b)は「新規1件を実際に
// 処理したときの合計」で、(b)-(a)が新規1件あたりの追加コストになる。
// maxNewItemsPerRun=0 は`parsePositiveInteger`が「0は正の整数でない」としてコード既定値に
// フォールバックするため使えない（0を指定してもキャップ無しと同じになる）。そのため(a)では
// フィールド自体を送らず、実際に新規候補が0件であることを確認する形にしている。
//
// (a)実行時にinserted/updatedが0でない場合（＝削除前から既に新規候補が存在していた場合）は
// 固定コストの実測が汚染されるため警告を出す。その場合は対象ルートの既存itemsをもう1件
// 削除してから再実行すること。
//
// 使い方: node --env-file=.env scripts/eval/eval-subrequests.mjs

const baseUrl = process.env.IMPORT_BASE_URL || 'http://localhost:4321';
const adminUser = process.env.ADMIN_USERNAME;
const adminPass = process.env.ADMIN_PASSWORD;
if (!adminUser || !adminPass) {
	console.error('ADMIN_USERNAME / ADMIN_PASSWORD が必要です（.env参照）。');
	process.exit(1);
}
const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`;

// defaultMaxNew は各インポーターの DEFAULT_MAX_NEW_ITEMS_PER_RUN と一致させる
// （src/lib/importers/{qiita,zenn,arxiv,hatena,blog,feed}.ts 参照。値を変更したらここも直す）。
const ROUTES = [
	{ name: 'qiita', path: '/api/import/qiita', defaultMaxNew: 10, body: () => ({}) },
	{ name: 'zenn', path: '/api/import/zenn', defaultMaxNew: 8, body: () => ({}) },
	{ name: 'arxiv', path: '/api/import/arxiv', defaultMaxNew: 10, body: () => ({}) },
	{ name: 'hatena', path: '/api/import/hatena', defaultMaxNew: 6, body: () => ({}) },
	// 実運用のcron（src/worker.ts）はキーワードローテーションで1語だけを渡すため、それに合わせる。
	// pages は上書きせず .env の BLOG_PAGES（未設定ならコード既定5）をそのまま使う。
	{ name: 'blog', path: '/api/import/blog', defaultMaxNew: 6, body: () => ({ query: 'pokeapi' }) },
	{ name: 'feed', path: '/api/import/feed', defaultMaxNew: 10, body: () => ({}) },
];

async function callRoute(route, maxNewItemsPerRunOverride) {
	const body = { ...route.body() };
	if (maxNewItemsPerRunOverride !== undefined) body.maxNewItemsPerRun = maxNewItemsPerRunOverride;
	const response = await fetch(`${baseUrl}${route.path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: authHeader },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${route.name} import failed (${response.status}): ${text}`);
	}
	const subrequestCountHeader = response.headers.get('X-Subrequest-Count');
	if (subrequestCountHeader === null) {
		throw new Error(
			`${route.name}: X-Subrequest-Count ヘッダーが無い。dev serverをDEBUG_SUBREQUEST_COUNT=1で起動しているか確認してください。`,
		);
	}
	return { subrequestCount: Number(subrequestCountHeader), result: JSON.parse(text).data };
}

async function main() {
	console.log('route\tfixedCost(0new)\twithOneTotal\tperItemCost\tdefaultMaxNew\tworstCase\t0new(f/i/u/s)\twithOne(f/i/u/s)');
	for (const route of ROUTES) {
		try {
			const baseline = await callRoute(route, undefined);
			const b = baseline.result;
			if ((b.inserted ?? 0) + (b.updated ?? 0) !== 0) {
				console.warn(
					`  [${route.name}] 定常状態のはずのベースライン呼び出しで inserted=${b.inserted} updated=${b.updated} と` +
						`新規が処理された。固定コストの実測が汚染されている。対象routeのitemsをもう1件削除してから再実行すること。`,
				);
			}
			const withOne = await callRoute(route, 1);
			const w = withOne.result;
			const fixedCost = baseline.subrequestCount;
			const withOneTotal = withOne.subrequestCount;
			const perItemCost = withOneTotal - fixedCost;
			console.log(
				`${route.name}\t${fixedCost}\t${withOneTotal}\t${perItemCost}\t${route.defaultMaxNew}\t` +
					`${fixedCost + perItemCost * route.defaultMaxNew}\t` +
					`${b.fetched}/${b.inserted}/${b.updated}/${b.skipped}\t${w.fetched}/${w.inserted}/${w.updated}/${w.skipped}`,
			);
			if ((w.inserted ?? 0) + (w.updated ?? 0) === 0) {
				console.warn(
					`  [${route.name}] maxNewItemsPerRun=1でもinserted/updatedが0だった。新規候補が既に無い可能性がある` +
						`（対象itemをもう1件削除してから再実行すること）。`,
				);
			}
		} catch (error) {
			console.error(`[${route.name}] failed:`, error.message ?? error);
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
