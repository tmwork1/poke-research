// M5: 検索精度の最適化フロー用スクリプト。
// `astro dev --background` で起動中のサーバーに対し、実データで代表的な検索条件を実行し、
// クエリごとのヒット件数とタイトル一覧を出力する。Claude Code がこの出力を読んで
// 関連性を判定し、問題があれば src/lib/catalog.ts 等を修正して再実行する、という
// 「試行→評価→修正」のループを回すための土台。OpenAI 等の外部AI採点は使わない。
const BASE_URL = process.env.EVAL_BASE_URL || 'http://localhost:4321';

// ここに検証したいクエリを追加していく。実データの語彙(タグ・タイトル)から
// 拾った代表例・境界例を並べておくと、実装を変えたときの回帰確認がしやすい。
const CASES = [
	{ label: '単語: ポケモン', params: { q: 'ポケモン' } },
	{ label: '単語: ポケモンカード', params: { q: 'ポケモンカード' } },
	{ label: '複合語(AND): ポケモン ROM', params: { q: 'ポケモン ROM' } },
	{ label: '複合語(AND): ポケモン Java', params: { q: 'ポケモン Java' } },
	{ label: '英語: python', params: { q: 'python' } },
	{ label: '英語: PokeAPI', params: { q: 'PokeAPI' } },
	{ label: '別表記: ポケットモンスター', params: { q: 'ポケットモンスター' } },
	{ label: 'タグ: ai', params: { tag: 'ai' } },
	{ label: 'タグ: pokemon', params: { tag: 'pokemon' } },
	{ label: 'タグ: ポケモン', params: { tag: 'ポケモン' } },
	{ label: 'kind: article', params: { kind: 'article' } },
	{ label: '該当なし想定: 存在しない単語xyzzy', params: { q: 'xyzzy12345' } },
];

async function runCase({ label, params }) {
	const url = new URL('/api/items', BASE_URL);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const response = await fetch(url);
	if (!response.ok) {
		console.log(`\n[${label}] ${url.toString()}`);
		console.log(`  ERROR: HTTP ${response.status}`);
		return;
	}

	const body = await response.json();
	const items = body.data ?? [];
	console.log(`\n[${label}] ${url.toString()}`);
	console.log(`  件数: ${items.length}`);
	for (const item of items.slice(0, 10)) {
		console.log(`  - (id=${item.id}) ${item.title}`);
	}
	if (items.length > 10) {
		console.log(`  ...ほか ${items.length - 10} 件`);
	}
}

async function main() {
	console.log(`対象サーバー: ${BASE_URL}（astro dev --background で起動しておくこと）`);
	for (const testCase of CASES) {
		await runCase(testCase);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
