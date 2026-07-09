// OpenAlex Works API レスポンス整形（openalex-parse.ts）の回帰テスト。
// openalex-parse.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// openalex.ts を経由せず直接ユニットテストできる（tests/arxiv-feed.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildOpenAlexFilter,
	extractAuthors,
	findArxivAbsUrl,
	reconstructAbstract,
	resolveTitle,
	selectExternalUrl,
	type OpenAlexWork,
} from '../src/lib/importers/openalex-parse.ts';

describe('reconstructAbstract', () => {
	it('null/undefinedなら空文字を返す', () => {
		assert.equal(reconstructAbstract(null), '');
		assert.equal(reconstructAbstract(undefined), '');
	});

	it('位置情報無しの空オブジェクトなら空文字を返す', () => {
		assert.equal(reconstructAbstract({}), '');
	});

	it('単語の出現位置順に並べ替えて復元する', () => {
		// 実際のOpenAlexレスポンス例（簡略化）: "We study Pokemon battles"
		const invertedIndex = {
			We: [0],
			study: [1],
			Pokemon: [2],
			battles: [3],
		};
		assert.equal(reconstructAbstract(invertedIndex), 'We study Pokemon battles');
	});

	it('同じ単語が複数位置に出現する場合も正しく復元する', () => {
		const invertedIndex = {
			Pokemon: [0, 3],
			battles: [1],
			vs: [2],
		};
		assert.equal(reconstructAbstract(invertedIndex), 'Pokemon battles vs Pokemon');
	});
});

function makeWork(overrides: Partial<OpenAlexWork> = {}): OpenAlexWork {
	return {
		id: 'https://openalex.org/W123',
		doi: null,
		title: 'Sample title',
		authorships: [],
		primary_location: null,
		locations: [],
		...overrides,
	};
}

describe('findArxivAbsUrl / selectExternalUrl', () => {
	it('primary_locationがarXivのlanding_page_urlならバージョン番号を除いて返す', () => {
		const work = makeWork({
			primary_location: { landing_page_url: 'http://arxiv.org/abs/2401.01234v2' },
		});
		assert.equal(findArxivAbsUrl(work), 'https://arxiv.org/abs/2401.01234');
		assert.equal(selectExternalUrl(work), 'https://arxiv.org/abs/2401.01234');
	});

	it('primary_locationに無くてもlocations配列内で見つかれば返す', () => {
		const work = makeWork({
			primary_location: { landing_page_url: 'https://doi.org/10.1234/xyz' },
			locations: [{ landing_page_url: 'https://journal.example/xyz' }, { landing_page_url: 'https://arxiv.org/abs/2402.05678' }],
		});
		assert.equal(findArxivAbsUrl(work), 'https://arxiv.org/abs/2402.05678');
	});

	it('arXiv locationが無くDOIがあればDOIを使う', () => {
		const work = makeWork({ doi: 'https://doi.org/10.7717/peerj.4375' });
		assert.equal(findArxivAbsUrl(work), null);
		assert.equal(selectExternalUrl(work), 'https://doi.org/10.7717/peerj.4375');
	});

	it('DOIがarXiv自身の登録プレフィックス（10.48550/arxiv.）ならarXivのURLへ変換する', () => {
		// 実データで確認した事例: OpenAlexは同一論文を doi=10.48550/arxiv.xxx のWorkと
		// primary_location=arxiv.org/abs/xxx のWorkに分けて持つことがある。
		// landing_page_urlにarxiv.orgが出てこないため、DOIも見ないとarxiv.tsの行と重複する。
		const work = makeWork({
			doi: 'https://doi.org/10.48550/arxiv.2604.10812',
			primary_location: { landing_page_url: 'https://doi.org/10.48550/arxiv.2604.10812' },
		});
		assert.equal(findArxivAbsUrl(work), 'https://arxiv.org/abs/2604.10812');
		assert.equal(selectExternalUrl(work), 'https://arxiv.org/abs/2604.10812');
	});

	it('arXiv locationもDOIも無ければOpenAlex IDを使う', () => {
		const work = makeWork({ id: 'https://openalex.org/W2741809807', doi: null });
		assert.equal(selectExternalUrl(work), 'https://openalex.org/W2741809807');
	});
});

describe('resolveTitle', () => {
	it('titleがあればそれを使う', () => {
		assert.equal(resolveTitle({ title: 'A', display_name: 'B' }), 'A');
	});

	it('titleが無ければdisplay_nameにフォールバックする', () => {
		assert.equal(resolveTitle({ title: null, display_name: 'B' }), 'B');
	});

	it('どちらも無ければ空文字を返す', () => {
		assert.equal(resolveTitle({}), '');
	});
});

describe('extractAuthors', () => {
	it('authorshipsからauthor.display_nameを取り出す', () => {
		const work = { authorships: [{ author: { display_name: 'Alice' } }, { author: { display_name: 'Bob' } }] };
		assert.deepEqual(extractAuthors(work), ['Alice', 'Bob']);
	});

	it('authorが欠けている要素は無視する', () => {
		const work = { authorships: [{ author: { display_name: 'Alice' } }, { author: null }, {}] };
		assert.deepEqual(extractAuthors(work), ['Alice']);
	});

	it('authorshipsが無ければ空配列を返す', () => {
		assert.deepEqual(extractAuthors({}), []);
	});
});

describe('buildOpenAlexFilter', () => {
	it('キーワードをpipe区切りのtitle_and_abstract.searchフィルタに変換する', () => {
		assert.equal(buildOpenAlexFilter(['pokeapi']), 'title_and_abstract.search:pokeapi');
	});

	it('pokemonはアクセント付き表記も同梱する', () => {
		assert.equal(buildOpenAlexFilter(['pokemon']), 'title_and_abstract.search:pokemon|pokémon');
	});

	it('複数キーワードを結合する', () => {
		assert.equal(buildOpenAlexFilter(['pokemon', 'pokeapi']), 'title_and_abstract.search:pokemon|pokémon|pokeapi');
	});
});
