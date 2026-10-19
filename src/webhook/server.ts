import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { runIncident } from '../orchestrator';
import { closePool } from '../lib/db';
import { logger } from '../lib/logger';
import { validateEnv } from '../lib/env';
import { AlertSchema } from './validation';
import { claimWebhookEvent } from '../lib/webhookEvents';
import { verifyPagerDutySignature, adaptPagerDuty } from './adapters/pagerduty';
import { adaptGrafana } from './adapters/grafana';
import { adaptAlertmanager } from './adapters/alertmanager';
import type { AlertPayload } from '../types/incident';

validateEnv();

const app = express();

app.set('trust proxy', parseInt(process.env.TRUST_PROXY ?? '1', 10));
app.use(helmet());

// Parse JSON preserving raw body for signature verification.
app.use(
  express.json({
    limit: '512kb',
    verify: (_req, _res, buf) => {
      (_req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  })
);

// Rate limits — lower for unauthenticated paths, higher for authenticated.
const strictLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
});

// ── Auth helpers ─────────────────────────────────────────────────────────────

function verifyBearerToken(req: Request, envVar: string): boolean {
  const expected = process.env[envVar];
  if (!expected) return false; // secret not configured → endpoint disabled
  const auth = req.headers['authorization'] ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      crypto.createHash('sha256').update(token).digest(),
      crypto.createHash('sha256').update(expected).digest()
    );
  } catch {
    return false;
  }
}

// ── Common handler ────────────────────────────────────────────────────────────

async function handleAlert(
  req: Request,
  res: Response,
  alert: AlertPayload,
  signatureVerified: boolean,
  eventType?: string
): Promise<void> {
  const requestId = crypto.randomUUID();

  // Atomic dedup — first delivery starts pipeline; duplicates get 200.
  let claim;
  try {
    claim = await claimWebhookEvent(alert, { eventType, signatureVerified });
  } catch (err) {
    logger.error('Webhook event claim failed', { requestId, error: (err as Error).message });
    res.status(503).json({ error: 'Database unavailable — please retry' });
    return;
  }

  if (!claim.firstDelivery) {
    res.status(200).json({
      incident_id: alert.incident_id,
      request_id: requestId,
      status: 'duplicate',
    });
    return;
  }

  logger.info('Alert accepted', {
    requestId,
    incident_id: alert.incident_id,
    title: alert.title,
    source: alert.alert_source,
  });

  res.status(202).json({ incident_id: alert.incident_id, request_id: requestId, status: 'accepted' });

  // Fire-and-forget — pipeline is async; results persist to Postgres.
  runIncident(alert).catch((err: Error) => {
    logger.error('Pipeline failed', { requestId, incident_id: alert.incident_id, error: err.message });
  });
}

// ── PagerDuty ─────────────────────────────────────────────────────────────────

app.post('/webhook/pagerduty', strictLimiter, (req, res) => {
  const secret = process.env.PAGERDUTY_WEBHOOK_SECRET;
  if (!secret) {
    res.status(401).json({ error: 'PagerDuty webhook not configured' });
    return;
  }

  const sigHeader = req.headers['x-pagerduty-signature'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    res.status(401).json({ error: 'Missing X-PagerDuty-Signature' });
    return;
  }

  const rawBody = (req as unknown as { rawBody: string }).rawBody ?? '';
  if (!verifyPagerDutySignature(secret, rawBody, sigHeader)) {
    logger.warn('Invalid PagerDuty signature', { ip: req.ip });
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const result = adaptPagerDuty(req.body);

  if (result.kind === 'ignore') {
    res.status(200).json({ status: 'ignored' });
    return;
  }

  if (result.kind === 'resolve') {
    // TODO: update existing incident status in P2.2
    res.status(200).json({ status: 'ignored', note: 'resolve events not yet fully handled' });
    return;
  }

  if (!result.alert) {
    res.status(400).json({ error: 'Could not parse alert from PagerDuty payload' });
    return;
  }

  handleAlert(req, res, result.alert, true, req.body?.event?.event_type).catch((e: Error) => {
    logger.error('handleAlert failed', { error: e.message });
  });
});

// ── Grafana ───────────────────────────────────────────────────────────────────

app.post('/webhook/grafana', strictLimiter, (req, res) => {
  if (!verifyBearerToken(req, 'GRAFANA_WEBHOOK_TOKEN')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = adaptGrafana(req.body);

  if (result.kind !== 'trigger' || !result.alert) {
    res.status(200).json({ status: result.kind === 'resolve' ? 'ignored' : 'ignored' });
    return;
  }

  handleAlert(req, res, result.alert, true, 'grafana.firing').catch((e: Error) => {
    logger.error('handleAlert failed', { error: e.message });
  });
});

// ── Alertmanager ──────────────────────────────────────────────────────────────

app.post('/webhook/alertmanager', strictLimiter, (req, res) => {
  if (!verifyBearerToken(req, 'ALERTMANAGER_WEBHOOK_TOKEN')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = adaptAlertmanager(req.body);

  if (result.kind !== 'trigger' || !result.alert) {
    res.status(200).json({ status: 'ignored' });
    return;
  }

  handleAlert(req, res, result.alert, true, 'alertmanager.firing').catch((e: Error) => {
    logger.error('handleAlert failed', { error: e.message });
  });
});

// ── Custom (legacy /webhook alias) ───────────────────────────────────────────

app.post(['/webhook/custom', '/webhook'], strictLimiter, (req, res) => {
  if (!verifyBearerToken(req, 'CUSTOM_WEBHOOK_TOKEN')) {
    // Legacy path: accept unauthenticated only in non-production with insecure dev mode.
    const allowInsecure =
      process.env.ALLOW_INSECURE_DEV === 'true' && process.env.NODE_ENV !== 'production';
    if (!allowInsecure) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    logger.warn('Custom webhook accepted without token (ALLOW_INSECURE_DEV=true)', { ip: req.ip });
  }

  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid alert payload', details: parsed.error.flatten() });
    return;
  }

  const alert = parsed.data as AlertPayload;
  handleAlert(req, res, alert, !!process.env.CUSTOM_WEBHOOK_TOKEN, 'custom.trigger').catch((e: Error) => {
    logger.error('handleAlert failed', { error: e.message });
  });
});

// ── Slack interactions (stub for P5.2) ────────────────────────────────────────

app.post('/slack/interactions', strictLimiter, (_req, res) => {
  res.status(200).json({ ok: true });
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', async (_req, res) => {
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

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down', { signal });
  server.close(async () => {
    await closePool();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
