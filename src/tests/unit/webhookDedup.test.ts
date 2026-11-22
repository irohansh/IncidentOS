import { describe, it, expect } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { claimWebhookEvent, dedupKey } from '../../lib/webhookEvents';
import type { AlertPayload } from '../../types/incident';

// In-memory stand-in for the UNIQUE(dedup_key) INSERT ... ON CONFLICT DO NOTHING RETURNING.
function fakeQuery() {
  const seen = new Set<string>();
  const fn = async <T extends QueryResultRow = QueryResultRow>(_text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const key = String(params?.[0]);
    const rows = seen.has(key) ? [] : (seen.add(key), [{ id: 'row-' + key }]);
    return { rows: rows as unknown as T[], rowCount: rows.length, command: 'INSERT', oid: 0, fields: [] };
  };
  return fn;
}

function alert(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    incident_id: 'INC-1',
    title: 'Checkout 5xx',
    alert_source: 'pagerduty',
    started_at: '2026-10-11T00:00:00Z',
    raw: {},
    ...overrides,
  };
}

describe('webhook duplicate-event protection', () => {
  it('first delivery is processed; identical re-delivery is a duplicate', async () => {
    const q = fakeQuery();
    const first = await claimWebhookEvent(alert(), { signatureVerified: true }, q);
    const second = await claimWebhookEvent(alert(), { signatureVerified: true }, q);
    expect(first.firstDelivery).toBe(true);
    expect(second.firstDelivery).toBe(false);
    expect(first.dedup_key).toBe(second.dedup_key);
  });

  it('different incidents are not deduped against each other', async () => {
    const q = fakeQuery();
    const a = await claimWebhookEvent(alert({ incident_id: 'INC-A' }), { signatureVerified: false }, q);
    const b = await claimWebhookEvent(alert({ incident_id: 'INC-B' }), { signatureVerified: false }, q);
    expect(a.firstDelivery).toBe(true);
    expect(b.firstDelivery).toBe(true);
  });

  it('dedup key prefers an explicit raw dedup_key over incident_id', () => {
    const k = dedupKey(alert({ raw: { dedup_key: 'pd-evt-999' } }));
    expect(k).toBe('pagerduty:pd-evt-999');
  });

  it('dedup key falls back to incident_id and is namespaced by source', () => {
    expect(dedupKey(alert({ incident_id: 'INC-7' }))).toBe('pagerduty:INC-7');
  });

  it('multiple PagerDuty lifecycle events for one incident collapse to one workflow', async () => {
    const q = fakeQuery();
    const triggered = await claimWebhookEvent(alert({ raw: { event_type: 'triggered' } }), { signatureVerified: true }, q);
    const acked     = await claimWebhookEvent(alert({ raw: { event_type: 'acknowledged' } }), { signatureVerified: true }, q);
    expect(triggered.firstDelivery).toBe(true);
    expect(acked.firstDelivery).toBe(false); // same incident_id ⇒ same dedup key
  });
});
