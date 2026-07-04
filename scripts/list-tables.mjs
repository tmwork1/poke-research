import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
  for (const row of res.rows) console.log(row.tablename);
} catch (e) {
  console.error(e);
  process.exit(2);
} finally {
  await client.end();
}
