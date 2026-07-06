// はてなブックマーク検索RSSパーサーの回帰テスト。
// hatena-feed.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// hatena.ts を経由せず直接ユニットテストできる（keywords.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeXmlEntities, parseHatenaSearchRss } from '../src/lib/importers/hatena-feed.ts';

// 実際の b.hatena.ne.jp/search/text?...&mode=rss のレスポンス形（RSS 1.0 RDF）を模したサンプル。
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns="http://purl.org/rss/1.0/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
>
<channel rdf:about="https://b.hatena.ne.jp/q/pokeapi">
<title>&#x672C;&#x6587;&#x300C;pokeapi&#x300D;&#x3092;&#x691C;&#x7D22;</title>
<items>
 <rdf:Seq>
  <rdf:li rdf:resource="https://qiita.com/example/items/aaa" />
  <rdf:li rdf:resource="https://example.hatenablog.com/entry/bbb" />
 </rdf:Seq>
</items>
</channel>
<item rdf:about="https://qiita.com/example/items/aaa">
<title>&#x5168;&#x30DD;&#x30B1;&#x30E2;&#x30F3;&#x306E;&#x540D;&#x5BC4;&#x305B;&#x30C7;&#x30FC;&#x30BF; &amp; API</title>
<link>https://qiita.com/example/items/aaa</link>
<dc:date>2026-06-01T10:00:00+09:00</dc:date>
</item>
<item rdf:about="https://example.hatenablog.com/entry/bbb">
<title>PokeAPI &lt;Python&gt; &quot;client&quot;</title>
<link>https://example.hatenablog.com/entry/bbb</link>
<dc:date>2026-05-20T08:30:00+09:00</dc:date>
</item>
</rdf:RDF>`;

describe('decodeXmlEntities', () => {
	it('16進数値文字参照をデコードする', () => {
		assert.equal(decodeXmlEntities('&#x30DD;&#x30B1;&#x30E2;&#x30F3;'), 'ポケモン');
	});

	it('10進数値文字参照をデコードする', () => {
		assert.equal(decodeXmlEntities('&#65;&#66;&#67;'), 'ABC');
	});

	it('基本的な名前付きエンティティをデコードする', () => {
		assert.equal(decodeXmlEntities('A &amp; B &lt;tag&gt; &quot;q&quot; &apos;a&apos;'), 'A & B <tag> "q" \'a\'');
	});
});

describe('parseHatenaSearchRss', () => {
	it('rdf:about を持つ item ブロックのみを個別記事として抽出する（items/rdf:Seq の参照リストは無視する）', () => {
		const entries = parseHatenaSearchRss(SAMPLE_RSS);
		assert.equal(entries.length, 2);
	});

	it('title/link/dc:date を正しく取り出し、エンティティをデコードする', () => {
		const entries = parseHatenaSearchRss(SAMPLE_RSS);
		assert.equal(entries[0].url, 'https://qiita.com/example/items/aaa');
		assert.equal(entries[0].title, '全ポケモンの名寄せデータ & API');
		assert.equal(entries[0].date, '2026-06-01T10:00:00+09:00');

		assert.equal(entries[1].url, 'https://example.hatenablog.com/entry/bbb');
		assert.equal(entries[1].title, 'PokeAPI <Python> "client"');
	});

	it('item が0件（該当なしクエリ）のフィードは空配列を返す', () => {
		const emptyRss = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="https://b.hatena.ne.jp/q/nonsense"><title>x</title><items><rdf:Seq></rdf:Seq></items></channel>
</rdf:RDF>`;
		assert.deepEqual(parseHatenaSearchRss(emptyRss), []);
	});

	it('dc:date が無い item では date が null になる', () => {
		const rssWithoutDate = `<item rdf:about="https://example.com/a"><title>no date</title><link>https://example.com/a</link></item>`;
		const entries = parseHatenaSearchRss(rssWithoutDate);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].date, null);
	});
});
