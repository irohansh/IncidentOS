import crypto from 'crypto';
import type { AdapterResult } from './types';
import type { AlertPayload } from '../../types/incident';

interface GrafanaAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
  dashboardURL?: string;
  panelURL?: string;
  values?: Record<string, number>;
}

interface GrafanaBody {
  status?: string;
  alerts?: GrafanaAlert[];
  groupKey?: string;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  title?: string;
  message?: string;
}

function shortHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function safeUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? href : null;
  } catch {
    return null;
  }
}

export function adaptGrafana(raw: unknown): AdapterResult {
  const body = raw as GrafanaBody;

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
      return [lbl.service, lbl.app, lbl.deployment].filter(Boolean) as string[];
    })
  ));

  const title =
    body.commonAnnotations?.summary ??
    firingAlerts[0]?.labels?.alertname ??
    body.title ??
    `Grafana alert group ${externalId}`;

  const startedAt =
    firingAlerts
      .map((a) => a.startsAt)
      .filter(Boolean)
      .sort()[0] ?? new Date().toISOString();

  const links: AlertPayload['links'] = [];
  for (const a of firingAlerts) {
    const dashboard = safeUrl(a.dashboardURL);
    if (dashboard) links.push({ href: dashboard, text: 'Grafana Dashboard' });
    const panel = safeUrl(a.panelURL);
    if (panel) links.push({ href: panel, text: 'Grafana Panel' });
    const gen = safeUrl(a.generatorURL);
    if (gen && links.length < 5) links.push({ href: gen, text: 'Alert Source' });
  }

  const alert: AlertPayload = {
    incident_id: `grafana:${externalId}`,
    title,
    alert_source: 'grafana',
    affected_services: services,
    started_at: startedAt,
    links: links.slice(0, 5),
    raw: raw as Record<string, unknown>,
  };

  return { kind: 'trigger', alert, externalId };
}
