import express from 'express';
import { runIncident } from '../orchestrator';
import type { AlertPayload } from '../types/incident';

const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  try {
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
