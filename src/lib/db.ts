import { Pool } from 'pg';

// Singleton pool shared across the entire server process.
// Prevents connection exhaustion from multiple Pool instances.
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      process.stderr.write(
        JSON.stringify({ level: 'error', msg: 'pg pool error', error: err.message }) + '\n'
      );
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
