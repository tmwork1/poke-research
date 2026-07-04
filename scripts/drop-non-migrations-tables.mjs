import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';
const dryRun = process.argv.includes('--dry-run');
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
  const tables = res.rows.map(r => r.tablename).filter(t => t !== 'migrations');

  if (tables.length === 0) {
    console.log('No non-migrations tables found.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('Would drop the following tables:');
    for (const t of tables) console.log('-', t);
    process.exit(0);
  }

  await client.query('BEGIN');
  for (const t of tables) {
    await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    console.log('Dropped', t);
  }
  await client.query('COMMIT');
  console.log('All non-migrations tables dropped.');
} catch (e) {
  try { await client.query('ROLLBACK'); } catch (__) {}
  console.error('Failed to drop tables:', e);
  process.exit(2);
} finally {
  await client.end();
}
