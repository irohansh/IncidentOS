import { callAgent } from '../lib/callAgent';
import type { IncidentState, RecentDeploy, RootCauseOutput } from '../types/incident';

export async function runRootCause(
  incident: IncidentState,
  recentDeploys: RecentDeploy[]
): Promise<RootCauseOutput> {
  return callAgent<RootCauseOutput>(
    'rootCause',
    { incident, recent_deploys: recentDeploys },
    incident.alert.incident_id
  );
}
