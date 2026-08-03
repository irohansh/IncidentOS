import 'dotenv/config';
import { query, closePool } from '../../lib/db';
import { logger } from '../../lib/logger';

// Query, idle past the pooler's idle window, query again — both must succeed.
// Requires DATABASE_URL. Read-only. Usage: npm run verify:db  (GAP_SECONDS overrides).
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is not set — cannot run DB verification');
    process.exit(1);
  }

  const gapSeconds = parseInt(process.env.GAP_SECONDS ?? '35', 10);

  logger.info('DB long-gap verification starting', { gap_seconds: gapSeconds });

  const first = await query<{ now: Date }>('SELECT now() AS now');
  logger.info('First query succeeded', { now: first.rows[0].now });

  logger.info(`Idling for ${gapSeconds}s...`);
  await new Promise((r) => setTimeout(r, gapSeconds * 1000));

  const start = Date.now();
  const second = await query<{ now: Date }>('SELECT now() AS now');
  logger.info('Second query succeeded after the gap', {
    now: second.rows[0].now,
    elapsed_ms: Date.now() - start,
  });

  logger.info('PASS — connection survived the long gap');
  await closePool();
  process.exit(0);
}

main().catch(async (err: Error) => {
  logger.error('FAIL — DB verification errored', { error: err.message });
  await closePool().catch(() => undefined);
  process.exit(1);
});
