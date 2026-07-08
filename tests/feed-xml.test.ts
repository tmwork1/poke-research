// RSS 2.0 / Atom フィードパーサーの回帰テスト。
// feed-xml.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// feed.ts を経由せず直接ユニットテストできる（hatena-feed.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAtomEntries, parseFeed, parseRssEntries } from '../src/lib/importers/feed-xml.ts';

const SAMPLE_RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Example Blog</title>
<item>
<title><![CDATA[ポケモン対戦ツールを作った話 & メモ]]></title>
<link>https://example.hatenablog.com/entry/aaa</link>
<pubDate>Mon, 01 Jun 2026 10:00:00 +0900</pubDate>
</item>
<item>
<title>PokeAPI &lt;Python&gt; client</title>
<link>https://example.hatenablog.com/entry/bbb</link>
<pubDate>Sun, 20 May 2026 08:30:00 +0900</pubDate>
</item>
</channel>
</rss>`;

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>note.com creator feed</title>
<entry>
<title>ダメージ計算ツールを実装した</title>
<link rel="self" href="https://note.com/example/rss"/>
<link rel="alternate" href="https://note.com/example/n/n1234567890ab"/>
<updated>2026-06-01T10:00:00+09:00</updated>
</entry>
<entry>
<title>&amp;記事タイトル&quot;引用符&quot;</title>
<link href="https://note.com/example/n/n2234567890ab"/>
<updated>2026-05-20T08:30:00+09:00</updated>
</entry>
</feed>`;

describe('parseRssEntries', () => {
	it('CDATAとタグ属性付きtitleを含むitemを抽出する', () => {
		const entries = parseRssEntries(SAMPLE_RSS2);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].url, 'https://example.hatenablog.com/entry/aaa');
		assert.equal(entries[0].title, 'ポケモン対戦ツールを作った話 & メモ');
		assert.equal(entries[0].date, 'Mon, 01 Jun 2026 10:00:00 +0900');
	});

	it('エンティティをデコードする', () => {
		const entries = parseRssEntries(SAMPLE_RSS2);
		assert.equal(entries[1].title, 'PokeAPI <Python> client');
	});

	it('itemが無いXMLは空配列を返す', () => {
		assert.deepEqual(parseRssEntries('<rss version="2.0"><channel></channel></rss>'), []);
	});
});

describe('parseAtomEntries', () => {
	it('rel="alternate"のlinkを優先してURLを抽出する（rel="self"は無視する）', () => {
		const entries = parseAtomEntries(SAMPLE_ATOM);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].url, 'https://note.com/example/n/n1234567890ab');
		assert.equal(entries[0].title, 'ダメージ計算ツールを実装した');
		assert.equal(entries[0].date, '2026-06-01T10:00:00+09:00');
	});

	it('rel属性が無いlinkはalternate扱いでフォールバックする', () => {
		const entries = parseAtomEntries(SAMPLE_ATOM);
		assert.equal(entries[1].url, 'https://note.com/example/n/n2234567890ab');
		assert.equal(entries[1].title, '&記事タイトル"引用符"');
	});

	it('entryが無いXMLは空配列を返す', () => {
		assert.deepEqual(parseAtomEntries('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), []);
	});
});

describe('parseFeed', () => {
	it('RSS 2.0はparseRssEntriesと同じ結果になる', () => {
		assert.deepEqual(parseFeed(SAMPLE_RSS2), parseRssEntries(SAMPLE_RSS2));
	});

	it('AtomはparseAtomEntriesと同じ結果になる', () => {
		assert.deepEqual(parseFeed(SAMPLE_ATOM), parseAtomEntries(SAMPLE_ATOM));
	});
});
