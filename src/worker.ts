/**
 * Incident job worker — picks jobs from incident_jobs, runs the pipeline,
 * and marks them done or failed. Survives restarts; one run per incident.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED for safe concurrency.
 */
import 'dotenv/config';
import { getPool, closePool, query } from './lib/db';
import { runIncident } from './orchestrator';
import { validateEnv } from './lib/env';
import { logger } from './lib/logger';
import type { AlertPayload } from './types/incident';

validateEnv();

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);
const LOCK_TIMEOUT_MS = parseInt(process.env.JOB_LOCK_TIMEOUT_MS ?? '900000', 10);
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 3;
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

let running = 0;
let stopping = false;

async function claimJob(): Promise<{ id: string; incident_id: string; attempts: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; incident_id: string; attempts: number }>(
      `SELECT id, incident_id, attempts
       FROM incident_jobs
       WHERE status = 'queued'
         AND run_after <= NOW()
         AND attempts < $1
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const job = rows[0];
    await client.query(
      `UPDATE incident_jobs
       SET status = 'running', locked_by = $1, locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
       WHERE id = $2`,
      [WORKER_ID, job.id]
    );
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function completeJob(jobId: string, success: boolean, error?: string): Promise<void> {
  await query(
    `UPDATE incident_jobs
     SET status = $1, last_error = $2, locked_by = NULL, locked_at = NULL, updated_at = NOW()
     WHERE id = $3`,
    [success ? 'done' : 'failed', error ?? null, jobId]
  );
}

async function requeueStaleJobs(): Promise<void> {
  const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  const { rowCount } = await query(
    `UPDATE incident_jobs
     SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = NOW(),
         run_after = NOW() + INTERVAL '5 seconds'
     WHERE status = 'running'
       AND locked_at < $1`,
    [staleThreshold]
  );
  if ((rowCount ?? 0) > 0) {
    logger.warn('Re-queued stale jobs', { count: rowCount, worker: WORKER_ID });
  }
}

async function getAlertForIncident(incidentId: string): Promise<AlertPayload | null> {
  const { rows } = await query<{ alert_payload: Record<string, unknown>; title: string; alert_source: string; started_at: string }>(
    `SELECT alert_payload, title, alert_source, started_at
     FROM incidents WHERE incident_id = $1`,
    [incidentId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const payload = row.alert_payload as Record<string, unknown>;
  return {
    incident_id: incidentId,
    title: row.title,
    alert_source: row.alert_source as AlertPayload['alert_source'],
    started_at: row.started_at,
    affected_services: (payload.affected_services as string[]) ?? [],
    raw: payload,
  };
}

async function processJob(job: { id: string; incident_id: string; attempts: number }): Promise<void> {
  logger.info('Processing job', { jobId: job.id, incident_id: job.incident_id, attempt: job.attempts });

  const alert = await getAlertForIncident(job.incident_id);
  if (!alert) {
    logger.error('Incident not found for job', { jobId: job.id, incident_id: job.incident_id });
    await completeJob(job.id, false, 'Incident row not found');
    return;
  }

  try {
    await runIncident(alert);
    await completeJob(job.id, true);
    logger.info('Job completed', { jobId: job.id, incident_id: job.incident_id });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Job failed', { jobId: job.id, incident_id: job.incident_id, error: msg, attempt: job.attempts });
    if (job.attempts >= MAX_ATTEMPTS) {
      await completeJob(job.id, false, msg);
    } else {
      // Exponential backoff before retry.
      const backoffSeconds = Math.pow(2, job.attempts) * 30;
      await query(
        `UPDATE incident_jobs
         SET status = 'queued', last_error = $1, locked_by = NULL, locked_at = NULL,
             run_after = NOW() + ($2 * INTERVAL '1 second'), updated_at = NOW()
         WHERE id = $3`,
        [msg, backoffSeconds, job.id]
      );
    }
  }
}

async function pollLoop(): Promise<void> {
  await requeueStaleJobs();

  while (!stopping) {
    if (running < CONCURRENCY) {
      const job = await claimJob().catch((err) => {
        logger.error('Failed to claim job', { error: (err as Error).message });
        return null;
      });

      if (job) {
        running++;
        processJob(job)
          .finally(() => { running--; })
          .catch(() => {});
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  logger.info('Worker shutting down', { signal });
  stopping = true;
  // Wait for in-flight jobs to finish (up to 60 s).
  const deadline = Date.now() + 60_000;
  while (running > 0 && Date.now() < deadline) {
    await sleep(500);
  }
  await closePool();
  logger.info('Worker shutdown complete', { remaining: running });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

logger.info('Worker started', { workerId: WORKER_ID, concurrency: CONCURRENCY });
pollLoop().catch((err) => {
  logger.error('Poll loop crashed', { error: err.message });
  process.exit(1);
});
