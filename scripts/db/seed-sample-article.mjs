import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';

const articleUrl = 'https://hfps4469.hatenablog.com/entry/2024/10/11/100325';
const sourceOriginUrl = 'https://hfps4469.hatenablog.com/';
const sourceName = 'ポケモンを頑張らない';
const articleTitle = '【ポケモンSV】上位構築のポケモンの型を機械的に分類する';
const articleSummary = 'バトルデータベースの公開データと構築記事を組み合わせ、上位構築のポケモンの型を機械的に分類する手法をまとめた記事。レンタルパーティ画像から特性や技を画像認識で抽出している。';

const sourceData = {
  name: sourceName,
  type: 'hatena-blog',
  origin_url: sourceOriginUrl,
  metadata: {
    site_name: sourceName,
    article_url: articleUrl,
    source: 'hatena',
  },
};

const itemData = {
  external_url: articleUrl,
  kind: 'article',
  title: articleTitle,
  summary: articleSummary,
  authors: null,
  published_at: '2024-10-11T10:03:25+09:00',
  updated_at: null,
  metadata: {
    site_name: sourceName,
    source: 'hatena',
    fetched_from: articleUrl,
    labels: ['ポケモンSV', 'スクリプト'],
  },
  version: null,
};

async function upsertSource(client) {
  const existing = await client.query('SELECT id FROM sources WHERE origin_url = $1 LIMIT 1', [sourceOriginUrl]);

  if (existing.rows.length > 0) {
    const sourceId = existing.rows[0].id;
    await client.query(
      'UPDATE sources SET name = $1, type = $2, metadata = $3 WHERE id = $4',
      [sourceData.name, sourceData.type, sourceData.metadata, sourceId],
    );
    return { id: sourceId, action: 'updated' };
  }

  const inserted = await client.query(
    'INSERT INTO sources (name, type, origin_url, metadata) VALUES ($1, $2, $3, $4) RETURNING id',
    [sourceData.name, sourceData.type, sourceData.origin_url, sourceData.metadata],
  );
  return { id: inserted.rows[0].id, action: 'inserted' };
}

async function upsertItem(client, sourceId) {
  const existing = await client.query('SELECT id FROM items WHERE external_url = $1 LIMIT 1', [articleUrl]);

  if (existing.rows.length > 0) {
    const itemId = existing.rows[0].id;
    await client.query(
      `UPDATE items
       SET source_id = $1,
           kind = $2,
           title = $3,
           authors = $4,
           summary = $5,
           published_at = $6,
           updated_at = $7,
           metadata = $8,
           version = $9
       WHERE id = $10`,
      [
        sourceId,
        itemData.kind,
        itemData.title,
        itemData.authors,
        itemData.summary,
        itemData.published_at,
        itemData.updated_at,
        itemData.metadata,
        itemData.version,
        itemId,
      ],
    );
    return { id: itemId, action: 'updated' };
  }

  const inserted = await client.query(
    `INSERT INTO items (
      source_id,
      external_url,
      kind,
      title,
      authors,
      summary,
      published_at,
      updated_at,
      metadata,
      version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      sourceId,
      itemData.external_url,
      itemData.kind,
      itemData.title,
      itemData.authors,
      itemData.summary,
      itemData.published_at,
      itemData.updated_at,
      itemData.metadata,
      itemData.version,
    ],
  );

  return { id: inserted.rows[0].id, action: 'inserted' };
}

async function upsertSummaryAnnotation(client, itemId) {
  const annotationValue = {
    text: articleSummary,
  };
  const annotationProvenance = {
    source: 'seed-sample-article',
    article_url: articleUrl,
  };

  const existing = await client.query(
    `SELECT id FROM annotations
     WHERE item_id = $1
       AND kind = $2
       AND provenance ->> 'source' = $3
     LIMIT 1`,
    [itemId, 'summary', 'seed-sample-article'],
  );

  if (existing.rows.length > 0) {
    const annotationId = existing.rows[0].id;
    await client.query(
      'UPDATE annotations SET value = $1, provenance = $2 WHERE id = $3',
      [annotationValue, annotationProvenance, annotationId],
    );
    return { id: annotationId, action: 'updated' };
  }

  const inserted = await client.query(
    'INSERT INTO annotations (item_id, author_id, kind, value, provenance) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [itemId, null, 'summary', annotationValue, annotationProvenance],
  );

  return { id: inserted.rows[0].id, action: 'inserted' };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const sourceResult = await upsertSource(client);
    const itemResult = await upsertItem(client, sourceResult.id);
    const annotationResult = await upsertSummaryAnnotation(client, itemResult.id);

    console.log('Sample article synced successfully.');
    console.log(`Source ${sourceResult.action}:`, sourceResult.id);
    console.log(`Item ${itemResult.action}:`, itemResult.id);
    console.log(`Annotation ${annotationResult.action}:`, annotationResult.id);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});