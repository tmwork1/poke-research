import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in environment. Run scripts/setup-env.ps1 or set env vars.');
  process.exit(1);
}

const sql = `
-- Grant broad dev permissions to simplify local development
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;
`;

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log('Running GRANT statements for development...');
    await client.query(sql);
    console.log('GRANT statements executed successfully.');
  } catch (e) {
    console.error('Error executing GRANT statements:', e);
    process.exit(2);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
