import crypto from 'crypto';
import type { AdapterResult } from './types';
import type { AlertPayload } from '../../types/incident';

// PagerDuty v3 webhook — HMAC-SHA256 of raw body, header: v1=<hex>[,v1=<hex>]
export function verifyPagerDutySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return header.split(',').some((part) => {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx) !== 'v1') return false;
    const sigHex = trimmed.slice(eqIdx + 1);
    try {
      return crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

interface PagerDutyEvent {
  event?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    data?: {
      id?: string;
      title?: string;
      status?: string;
      html_url?: string;
      created_at?: string;
      urgency?: string;
      priority?: { summary?: string };
      service?: { id?: string; summary?: string };
      assignees?: unknown[];
    };
  };
}

export function adaptPagerDuty(raw: unknown): AdapterResult {
  const body = raw as PagerDutyEvent;
  const event = body.event;
  const data = event?.data;

  const externalId = data?.id ?? event?.id ?? 'unknown';
  const eventType = event?.event_type ?? '';

  if (eventType === 'incident.triggered') {
    const incidentId = `pagerduty:${externalId}`;
    const alert: AlertPayload = {
      incident_id: incidentId,
      title: data?.title ?? `PagerDuty incident ${externalId}`,
      alert_source: 'pagerduty',
      severity_hint: data?.priority?.summary ?? data?.urgency,
      affected_services: data?.service?.summary ? [data.service.summary] : [],
      started_at: data?.created_at ?? event?.occurred_at ?? new Date().toISOString(),
      links: data?.html_url ? [{ href: data.html_url, text: 'PagerDuty' }] : [],
      raw: raw as Record<string, unknown>,
    };
    return { kind: 'trigger', alert, externalId };
  }

  if (eventType === 'incident.acknowledged' || eventType === 'incident.resolved') {
    return { kind: 'resolve', externalId };
  }

  return { kind: 'ignore', externalId };
}
