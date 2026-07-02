import { callAgent } from '../lib/callAgent';
import type { IncidentState, RunbookStep, ExecutorOutput } from '../types/incident';

export async function runExecutor(
  incident: IncidentState,
  approvedStep: RunbookStep,
  previousResult?: ExecutorOutput
): Promise<ExecutorOutput> {
  return callAgent<ExecutorOutput>(
    'executor',
    { incident, approved_step: approvedStep, previous_step_result: previousResult },
    incident.alert.incident_id
  );
}
