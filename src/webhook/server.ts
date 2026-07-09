import express from 'express';
import crypto from 'crypto';
import { runIncident } from '../orchestrator';
import type { AlertPayload } from '../types/incident';

const app = express();

// Capture raw body for PagerDuty signature verification before JSON parsing
app.use(
  express.json({
    verify: (_req, _res, buf) => {
      (_req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  })
);

// PagerDuty v1 HMAC-SHA256 signature: "v1=<hex>,v1=<hex>,..."
// https://developer.pagerduty.com/docs/db0fa8c8984fc-verifying-webhook-signatures
function verifyPagerDutySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return header.split(',').some(part => {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx) !== 'v1') return false;
    const sigHex = trimmed.slice(eqIdx + 1);
    try {
      return crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false; // malformed hex
    }
  });
}

app.post('/webhook', async (req, res) => {
  try {
    const secret = process.env.PAGERDUTY_WEBHOOK_SECRET;
    if (secret) {
      const sigHeader = req.headers['x-pagerduty-signature'];
      if (!sigHeader || typeof sigHeader !== 'string') {
        res.status(401).json({ error: 'Missing X-PagerDuty-Signature header' });
        return;
      }
      const rawBody = (req as unknown as { rawBody: string }).rawBody ?? '';
      if (!verifyPagerDutySignature(secret, rawBody, sigHeader)) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    const alert = req.body as AlertPayload;
    if (!alert.incident_id || !alert.title || !alert.alert_source) {
      res.status(400).json({ error: 'Missing required fields: incident_id, title, alert_source' });
      return;
    }
    console.log(`[webhook] Received alert: ${alert.incident_id} — ${alert.title}`);
    const result = await runIncident(alert);
    res.json({ incident_id: alert.incident_id, postmortem: result.postmortem, timeline: result.timeline });
  } catch (err) {
    console.error('[webhook] Error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`[webhook] IncidentOS listening on port ${PORT}`);
});
