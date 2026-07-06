// M5: 収集クエリ（検索の入り口）精度の最適化フロー用スクリプト。
// Qiita/Zenn/note の検索・一覧APIを、現在の収集条件（既定クエリ/トピック）で
// AIレビューを通す前の生データとして直接叩き、タイトル一覧を出力する。
// OpenAI は呼ばない。Claude Code がタイトルを読み、ポケモンのプログラミング・開発と
// 無関係な記事（ゴミ）がどれだけ混ざっているかを自分で判定し、割合が高ければ
// 各インポーターの既定クエリ/トピック（qiita.ts/zenn.ts/note.tsのDEFAULT_*）を
// 見直して再実行する、というループの土台として使う。
// 収集済みDBの記事（eval-filter.mjsの対象）はこのAPIが返した結果からAIレビューで
// 選別された後のものなので、ここで見るのはそれより手前の母集団そのもの。

import { topic } from '../../src/config/topic.config.mjs';

const USER_AGENT = `${topic.site.slug}-eval`;

async function fetchQiitaTitles(query, pages = 2, perPage = 100) {
	const titles = [];
	for (let page = 1; page <= pages; page += 1) {
		const url = new URL('https://qiita.com/api/v2/items');
		url.searchParams.set('query', query);
		url.searchParams.set('page', String(page));
		url.searchParams.set('per_page', String(perPage));

		const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (!response.ok) throw new Error(`Qiita API failed (${response.status}): ${await response.text()}`);
		const items = await response.json();
		if (items.length === 0) break;

		for (const item of items) {
			titles.push({ title: item.title, tags: (item.tags ?? []).map((t) => t.name).join(',') });
		}
		if (items.length < perPage) break;
	}
	return titles;
}

async function fetchZennTitles(topicsCsv, pages = 2) {
	// zenn.ts と同じく、カンマ区切りのトピックをそれぞれ叩いてマージ・重複排除する。
	const topics = [...new Set(topicsCsv.split(',').map((t) => t.trim()).filter((t) => t.length > 0))];
	const titles = [];
	const seen = new Set();

	for (const topic of topics) {
		for (let page = 1; page <= pages; page += 1) {
			const url = new URL('https://zenn.dev/api/articles');
			url.searchParams.set('topicname', topic);
			url.searchParams.set('order', 'latest');
			url.searchParams.set('page', String(page));

			const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
			if (!response.ok) throw new Error(`Zenn API failed (${response.status}): ${await response.text()}`);
			const { articles, next_page } = await response.json();
			if (articles.length === 0) break;

			for (const article of articles) {
				if (seen.has(article.slug)) continue;
				seen.add(article.slug);
				titles.push({ title: article.title, tags: '' });
			}
			if (next_page === null) break;
		}
	}
	return titles;
}

async function fetchNoteTitles(query, pages = 2, size = 20) {
	const titles = [];
	for (let page = 0; page < pages; page += 1) {
		const url = new URL('https://note.com/api/v3/searches');
		url.searchParams.set('context', 'note');
		url.searchParams.set('q', query);
		url.searchParams.set('size', String(size));
		url.searchParams.set('start', String(page * size));

		const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (!response.ok) throw new Error(`note API failed (${response.status}): ${await response.text()}`);
		const payload = await response.json();
		const contents = payload.data.notes.contents;
		if (contents.length === 0) break;

		for (const item of contents) {
			titles.push({ title: item.name, tags: item.can_read ? '' : '(有料/読めない)' });
		}
		if (contents.length < size) break;
	}
	return titles;
}

function printSection(label, query, entries) {
	console.log(`\n=== ${label}（検索条件: "${query}"） ${entries.length}件 ===`);
	entries.forEach((entry, i) => {
		const suffix = entry.tags ? `  [${entry.tags}]` : '';
		console.log(`${i + 1}. ${entry.title}${suffix}`);
	});
}

async function main() {
	// 既定値は各インポーター（qiita.ts/note.ts）の実際のDEFAULT_QUERYと一致させること。
	// 検索語自体の唯一の管理場所は src/lib/importers/keywords.ts。
	const qiitaQuery = process.env.QIITA_QUERY?.trim() || 'title:ポケモン OR title:ポケカ OR tag:ポケモン';
	const zennTopic = process.env.ZENN_TOPIC?.trim() || topic.collection.zennTopics[0];
	const noteQuery = process.env.NOTE_QUERY?.trim() || 'ポケモン';

	console.log('AIレビュー前の生の検索結果（タイトルのみ）。ポケモンのプログラミング・開発と');
	console.log('無関係な記事（ゴミ）がどれだけ混ざっているか、Claude Codeがタイトルを見て判定すること。');

	const [qiita, zenn, note] = await Promise.all([
		fetchQiitaTitles(qiitaQuery),
		fetchZennTitles(zennTopic),
		fetchNoteTitles(noteQuery),
	]);

	printSection('Qiita', qiitaQuery, qiita);
	printSection('Zenn', zennTopic, zenn);
	printSection('note', noteQuery, note);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
