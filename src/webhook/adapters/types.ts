import type { AlertPayload } from '../../types/incident';

export type AlertKind = 'trigger' | 'resolve' | 'ignore';

export interface AdapterResult {
  kind: AlertKind;
  alert?: AlertPayload;
  externalId: string;
}
