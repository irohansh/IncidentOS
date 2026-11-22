import { callAgent } from '../lib/callAgent';
import type { LibraryRunbook } from '../lib/runbookLibrary';
import type { IncidentState, Hypothesis, RunbookOutput } from '../types/incident';

export async function runRunbook(
  incident: IncidentState,
  topHypothesis: Hypothesis,
  availableRunbooks: LibraryRunbook[] = [],
  runbookHints: string[] = []
): Promise<RunbookOutput> {
  return callAgent<RunbookOutput>(
    'runbook',
    {
      incident,
      top_hypothesis: topHypothesis,
      available_runbooks: availableRunbooks.map((rb) => ({
        id: rb.id,
        title: rb.title,
        triggers: rb.triggers,
        step_count: rb.steps.length,
      })),
      runbook_hints: runbookHints,
      executor_capabilities: ['kubectl', 'postgres', 'docker', 'bash'],
    },
    incident.alert.incident_id
  );
}
