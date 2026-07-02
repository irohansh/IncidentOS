import { callAgent } from '../lib/callAgent';
import type { AlertPayload, MetricsSnapshot, TriageOutput } from '../types/incident';

export async function runTriage(
  alert: AlertPayload,
  metrics: MetricsSnapshot
): Promise<TriageOutput> {
  return callAgent<TriageOutput>('triage', { alert, metrics }, alert.incident_id);
}
