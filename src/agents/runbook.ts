import { callAgent } from '../lib/callAgent';
import type { IncidentState, Hypothesis, RunbookOutput } from '../types/incident';

export async function runRunbook(
  incident: IncidentState,
  topHypothesis: Hypothesis
): Promise<RunbookOutput> {
  return callAgent<RunbookOutput>(
    'runbook',
    {
      incident,
      top_hypothesis: topHypothesis,
      available_runbooks: [],
      executor_capabilities: ['kubectl', 'postgres', 'docker', 'bash'],
    },
    incident.alert.incident_id
  );
}
