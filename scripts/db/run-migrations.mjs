import fs from 'fs/promises';
import path from 'path';
import { Client } from 'pg';

const migrationsDir = path.join(process.cwd(), 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL not set. Use scripts/setup-env.ps1 or export env.');
  process.exit(1);
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id serial PRIMARY KEY,
      name text UNIQUE NOT NULL,
      applied_at timestamptz DEFAULT now()
    );
  `);
}

async function getApplied(client) {
  const res = await client.query('SELECT name FROM migrations');
  return new Set(res.rows.map((r) => r.name));
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    for (const file of sqlFiles) {
      if (applied.has(file)) {
        console.log('Skipping already applied:', file);
        continue;
      }
      console.log('Applying migration:', file);
      const content = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(content);
        await client.query('INSERT INTO migrations(name) VALUES($1)', [file]);
        await client.query('COMMIT');
        console.log('Applied:', file);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Failed migration:', file, e);
        process.exit(2);
      }
    }
    console.log('All migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
