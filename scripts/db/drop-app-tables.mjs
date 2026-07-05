import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';
const client = new Client({ connectionString: databaseUrl });

const tables = ['annotations','item_tags','items','research_note_items','research_notes','sources','tags','users'];

try {
  await client.connect();
  await client.query('BEGIN');
  for (const t of tables) {
    await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log('Dropped', t);
  }
  await client.query('COMMIT');
  console.log('All specified tables dropped');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Failed to drop tables', e);
  process.exit(2);
} finally {
  await client.end();
}
