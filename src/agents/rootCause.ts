import { callAgent } from '../lib/callAgent';
import type { IncidentState, MetricsSnapshot, RecentDeploy, RootCauseOutput } from '../types/incident';

// Typed constant used by the parity test (S13) to verify agent payload matches prompt.
export const ROOT_CAUSE_INPUT_FIELDS = [
  'incident',
  'recent_deploys',
  'metrics_history',
  'correlated_alerts',
  'runbook_hints',
] as const;

export async function runRootCause(
  incident: IncidentState,
  recentDeploys: RecentDeploy[],
  metricsHistory: MetricsSnapshot[] = [],
  correlatedAlerts: string[] = [],
  runbookHints: string[] = []
): Promise<RootCauseOutput> {
  return callAgent<RootCauseOutput>(
    'rootCause',
    {
      incident,
      recent_deploys: recentDeploys,
      metrics_history: metricsHistory,
      correlated_alerts: correlatedAlerts,
      runbook_hints: runbookHints,
    },
    incident.alert.incident_id
  );
}
