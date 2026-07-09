// arXiv API（Atom フィード）パーサーの回帰テスト。
// arxiv-feed.ts は cloudflare:workers 等の外部依存を持たない純粋なファイルのため、
// arxiv.ts を経由せず直接ユニットテストできる（hatena-feed.test.ts と同じ方針）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArxivFeed } from '../src/lib/importers/arxiv-feed.ts';

// 実際の https://export.arxiv.org/api/query のレスポンス形（Atom）を模したサンプル。
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <link href="http://arxiv.org/api/query?search_query=all:pokemon" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:pokemon</title>
  <id>http://arxiv.org/api/query</id>
  <updated>2026-07-09T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">10</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2024-02-01T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Reinforcement Learning for
   Pokemon Battles &amp; Team Building</title>
    <summary>  We study reinforcement learning agents that play
  Pokemon battles. Our approach &lt;matters&gt; because...
    </summary>
    <author>
      <name>Alice Example</name>
    </author>
    <author>
      <name>Bob Example</name>
    </author>
    <link href="http://arxiv.org/abs/2401.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.05678v1</id>
    <updated>2024-02-05T00:00:00Z</updated>
    <published>2024-02-05T00:00:00Z</published>
    <title>PokeAPI-based Dataset for Graph Learning</title>
    <summary>A dataset built from PokeAPI for graph neural network benchmarks.</summary>
    <author>
      <name>Carol Example</name>
    </author>
    <link href="http://arxiv.org/abs/2402.05678v1" rel="alternate" type="text/html"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe('parseArxivFeed', () => {
	it('entry ブロックをすべて抽出する', () => {
		const entries = parseArxivFeed(SAMPLE_FEED);
		assert.equal(entries.length, 2);
	});

	it('id/title/summary の空白・改行を正規化し、XMLエンティティをデコードする', () => {
		const entries = parseArxivFeed(SAMPLE_FEED);
		const first = entries[0];
		assert.equal(first.id, 'http://arxiv.org/abs/2401.01234v2');
		assert.equal(first.title, 'Reinforcement Learning for Pokemon Battles & Team Building');
		assert.equal(first.summary, 'We study reinforcement learning agents that play Pokemon battles. Our approach <matters> because...');
	});

	it('複数の author を name の配列として取り出す', () => {
		const entries = parseArxivFeed(SAMPLE_FEED);
		assert.deepEqual(entries[0].authors, ['Alice Example', 'Bob Example']);
		assert.deepEqual(entries[1].authors, ['Carol Example']);
	});

	it('published/updated を取り出す', () => {
		const entries = parseArxivFeed(SAMPLE_FEED);
		assert.equal(entries[0].published, '2024-01-01T00:00:00Z');
		assert.equal(entries[0].updated, '2024-02-01T00:00:00Z');
	});

	it('category / primary_category を取り出す（重複は除去する）', () => {
		const entries = parseArxivFeed(SAMPLE_FEED);
		assert.equal(entries[0].primaryCategory, 'cs.AI');
		assert.deepEqual(entries[0].categories, ['cs.AI', 'cs.LG']);
		assert.equal(entries[1].primaryCategory, 'cs.LG');
		assert.deepEqual(entries[1].categories, ['cs.LG']);
	});

	it('エラー応答（id が /abs/ を含まない entry）は無視する', () => {
		const errorFeed = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/api/errors#incorrect_id_format_for_id</id>
  <title>Error</title>
  <summary>incorrect id format for id</summary>
</entry>
</feed>`;
		assert.deepEqual(parseArxivFeed(errorFeed), []);
	});

	it('entry が0件のフィードは空配列を返す', () => {
		const emptyFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`;
		assert.deepEqual(parseArxivFeed(emptyFeed), []);
	});
});
