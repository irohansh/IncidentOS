import { callAgent } from '../lib/callAgent';
import type {
  IncidentState,
  RunbookStep,
  ExecutorOutput,
  MetricsSnapshot,
  ValidatorOutput,
} from '../types/incident';

export async function runValidator(
  incident: IncidentState,
  executedStep: ExecutorOutput,
  runbookStep: RunbookStep,
  metricsBefore: MetricsSnapshot,
  metricsAfter: MetricsSnapshot
): Promise<ValidatorOutput> {
  return callAgent<ValidatorOutput>(
    'validator',
    {
      incident,
      executed_step: executedStep,
      runbook_step: runbookStep,
      metrics_before: metricsBefore,
      metrics_after: metricsAfter,
    },
    incident.alert.incident_id
  );
}
