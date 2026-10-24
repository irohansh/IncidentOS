import { callAgent } from '../lib/callAgent';
import type { AlertPayload, MetricsSnapshot, TriageOutput } from '../types/incident';

export interface RecentIncidentSummary {
  incident_id: string;
  title: string;
  severity: string | null;
  status: string;
  started_at: string;
}

// Typed constant used by the parity test (S13) to verify agent payload matches prompt.
export const TRIAGE_INPUT_FIELDS = ['alert', 'metrics', 'recent_incidents'] as const;

export async function runTriage(
  alert: AlertPayload,
  metrics: MetricsSnapshot,
  recentIncidents: RecentIncidentSummary[] = []
): Promise<TriageOutput> {
  return callAgent<TriageOutput>(
    'triage',
    { alert, metrics, recent_incidents: recentIncidents },
    alert.incident_id
  );
}
