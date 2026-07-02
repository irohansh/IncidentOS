import { callAgent } from '../lib/callAgent';
import type { IncidentState, CommsOutput } from '../types/incident';

export interface CommsContext {
  company_name: string;
  product_name: string;
  status_page_url: string;
  support_email: string;
}

export async function runComms(
  incident: IncidentState,
  ctx: CommsContext
): Promise<CommsOutput> {
  return callAgent<CommsOutput>(
    'comms',
    { incident, ...ctx },
    incident.alert.incident_id
  );
}
