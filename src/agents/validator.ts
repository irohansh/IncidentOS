import { callAgent } from '../lib/callAgent';
import type {
  IncidentState,
  RunbookStep,
  ExecutorOutput,
  MetricsSnapshot,
  ValidatorOutput,
} from '../types/incident';

function metricsAvailable(snap: MetricsSnapshot): boolean {
  const h = snap.integration_health;
  if (!h) return false;
  // If Prometheus is not configured or unavailable, we have no real data.
  if (h.prometheus !== 'ok') return false;
  const retrieved = h.metrics_retrieved ?? [];
  return retrieved.length > 0;
}

export async function runValidator(
  incident: IncidentState,
  executedStep: ExecutorOutput,
  runbookStep: RunbookStep,
  metricsBefore: MetricsSnapshot,
  metricsAfter: MetricsSnapshot
): Promise<ValidatorOutput> {
  // P1.4: If metrics are missing/unconfigured, return 'unknown' — never auto-resolve.
  if (!metricsAvailable(metricsBefore) || !metricsAvailable(metricsAfter)) {
    const result = await callAgent<ValidatorOutput>(
      'validator',
      {
        incident_id: incident.alert.incident_id,
        executed_step: executedStep,
        runbook_step: runbookStep,
        metrics_before: metricsBefore,
        metrics_after: metricsAfter,
        note: 'Metrics are unavailable or not configured. You MUST return verdict: "unknown". Do NOT claim resolution.',
      },
      incident.alert.incident_id
    );
    // Code enforces unknown — AI cannot override this.
    return {
      ...result,
      verdict: 'unknown',
      resolved: false,
      recommendation: result.recommendation === 'mark_resolved' ? 'escalate' : result.recommendation,
    };
  }

  return callAgent<ValidatorOutput>(
    'validator',
    {
      incident_id: incident.alert.incident_id,
      executed_step: executedStep,
      runbook_step: runbookStep,
      metrics_before: metricsBefore,
      metrics_after: metricsAfter,
    },
    incident.alert.incident_id
  );
}
