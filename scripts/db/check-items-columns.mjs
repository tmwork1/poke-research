import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='items' ORDER BY ordinal_position;");
  console.log(JSON.stringify(res.rows, null, 2));
} catch (e) {
  console.error(e);
  process.exit(2);
} finally {
  await client.end();
}
