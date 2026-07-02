import { callAgent } from '../lib/callAgent';
import type { IncidentState, PostmortemOutput } from '../types/incident';

export async function runPostmortem(
  incident: IncidentState,
  resolutionConfirmedAt: string,
  totalDurationMinutes: number
): Promise<PostmortemOutput> {
  return callAgent<PostmortemOutput>(
    'postmortem',
    {
      incident,
      resolution_confirmed_at: resolutionConfirmedAt,
      total_duration_minutes: totalDurationMinutes,
    },
    incident.alert.incident_id
  );
}
