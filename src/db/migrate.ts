import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../lib/db';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations(): Promise<void> {
  const pool = getPool();

  // Create schema_migrations table if not exists.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query<{ version: string }>(
    `SELECT version FROM schema_migrations ORDER BY version`
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    if (appliedSet.has(version)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  apply ${file} ...`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
        [version]
      );
      await client.query('COMMIT');
      console.log(`  done  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log('Migrations complete.');
}

runMigrations()
  .then(() => closePool())
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
