import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { runIncident } from '../orchestrator';
import { closePool } from '../lib/db';
import { logger } from '../lib/logger';
import { validateEnv } from '../lib/env';
import { AlertSchema, verifyPagerDutySignature } from './validation';
import type { AlertPayload } from '../types/incident';

validateEnv();

const app = express();

// Security headers
app.use(helmet());

// Parse raw body before JSON so PagerDuty signature verification works
app.use(
  express.json({
    limit: '512kb',
    verify: (_req, _res, buf) => {
      (_req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  })
);

// Rate limit: 20 webhook calls per minute per IP (prevents runaway retries and cost abuse)
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
});

app.post('/webhook', webhookLimiter, (req, res) => {
  const requestId = crypto.randomUUID();

  const secret = process.env.PAGERDUTY_WEBHOOK_SECRET;
  if (secret) {
    const sigHeader = req.headers['x-pagerduty-signature'];
    if (!sigHeader || typeof sigHeader !== 'string') {
      res.status(401).json({ error: 'Missing X-PagerDuty-Signature header' });
      return;
    }
    const rawBody = (req as unknown as { rawBody: string }).rawBody ?? '';
    if (!verifyPagerDutySignature(secret, rawBody, sigHeader)) {
      logger.warn('Invalid webhook signature', { requestId, ip: req.ip });
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid alert payload', details: parsed.error.flatten() });
    return;
  }

  const alert = parsed.data as AlertPayload;
  logger.info('Alert received', { requestId, incident_id: alert.incident_id, title: alert.title });

  // Respond immediately — PagerDuty and other sources expect a fast 202.
  // The pipeline runs asynchronously; results are persisted to Postgres.
  res.status(202).json({ incident_id: alert.incident_id, request_id: requestId, status: 'accepted' });

  // Fire-and-forget with structured error logging
  runIncident(alert).catch((err: Error) => {
    logger.error('Pipeline failed', { requestId, incident_id: alert.incident_id, error: err.message });
  });
});

app.get('/health', async (_req, res) => {
  try {
    const { getPool } = await import('../lib/db');
    await getPool().query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unreachable', timestamp: new Date().toISOString() });
  }
});

const PORT = process.env.PORT ?? 3000;
const server = app.listen(PORT, () => {
  logger.info('IncidentOS webhook server started', { port: PORT });
});

// Graceful shutdown: drain in-flight requests and close DB pool
async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down', { signal });
  server.close(async () => {
    await closePool();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  // Force-exit after 30 seconds
  setTimeout(() => process.exit(1), 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
