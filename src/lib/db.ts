import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { logger } from './logger';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      // keepAlive stops Neon's pooler from reaping idle connections during long agent calls.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });

    _pool.on('error', (err) => {
      logger.error('pg pool error', { error: err.message });
    });
  }
  return _pool;
}

// Connection-level failures only — retrying these is safe because the query never
// committed. Constraint/syntax errors are intentionally excluded.
const RETRYABLE_MESSAGES = [
  'connection terminated due to connection timeout',
  'connection terminated unexpectedly',
  'connection terminated',
  'timeout exceeded when trying to connect',
  'server closed the connection unexpectedly',
  'connection reset by peer',
  'read econnreset',
  'econnreset',
  'epipe',
  'etimedout',
  'client has encountered a connection error and is not queryable',
];

const RETRYABLE_CODES = new Set(['08000', '08003', '08006', '57P01', '57P02', '57P03']);

export function isRetryable(err: unknown): boolean {
  const e = err as { message?: string; code?: string };
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;
  const msg = (e.message ?? '').toLowerCase();
  return RETRYABLE_MESSAGES.some((m) => msg.includes(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff between attempts; length sets the retry count.
const RETRY_BACKOFF_MS = [250, 750];

// sleepFn is injectable so tests run without real delays.
export async function runWithRetry<T>(
  op: () => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = sleep
): Promise<T> {
  const maxAttempts = RETRY_BACKOFF_MS.length + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const backoff = RETRY_BACKOFF_MS[attempt - 1];
      logger.warn('DB query failed — retrying transient connection error', {
        attempt,
        of: maxAttempts,
        backoff_ms: backoff,
        error: (err as Error).message,
      });
      await sleepFn(backoff);
    }
  }

  throw lastErr;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return runWithRetry(() => getPool().query<T>(text, params));
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
