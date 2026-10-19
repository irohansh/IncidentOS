import crypto from 'crypto';
import type { AdapterResult } from './types';
import type { AlertPayload } from '../../types/incident';

interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

interface AlertmanagerBody {
  version?: string;
  groupKey?: string;
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  alerts?: AmAlert[];
}

function shortHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export function adaptAlertmanager(raw: unknown): AdapterResult {
  const body = raw as AlertmanagerBody;

  const groupKey = body.groupKey ?? String(Date.now());
  const externalId = shortHash(groupKey);
  const status = body.status ?? '';

  if (status !== 'firing') {
    return { kind: status === 'resolved' ? 'resolve' : 'ignore', externalId };
  }

  const alerts = body.alerts ?? [];
  const firingAlerts = alerts.filter((a) => a.status === 'firing' || !a.status);

  const services = Array.from(new Set(
    firingAlerts.flatMap((a) => {
      const lbl = a.labels ?? {};
      return [lbl.service, lbl.app, lbl.deployment, lbl.job].filter(Boolean) as string[];
    })
  ));

  const commonLabels = body.commonLabels ?? {};
  const commonAnnotations = body.commonAnnotations ?? {};

  const title =
    commonAnnotations.summary ??
    commonLabels.alertname ??
    firingAlerts[0]?.labels?.alertname ??
    `Alertmanager group ${externalId}`;

  const startedAt =
    firingAlerts
      .map((a) => a.startsAt)
      .filter(Boolean)
      .sort()[0] ?? new Date().toISOString();

  const alert: AlertPayload = {
    incident_id: `alertmanager:${externalId}`,
    title,
    alert_source: 'grafana', // normalized to grafana for pipeline
    affected_services: services,
    started_at: startedAt,
    links: [],
    raw: raw as Record<string, unknown>,
  };

  return { kind: 'trigger', alert, externalId };
}
