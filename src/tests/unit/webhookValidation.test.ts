import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { AlertSchema, verifyPagerDutySignature } from '../../webhook/validation';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return 'v1=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyPagerDutySignature', () => {
  const body = JSON.stringify({ event: 'trigger', id: 'abc' });

  it('accepts a correctly signed payload', () => {
    expect(verifyPagerDutySignature(SECRET, body, sign(body))).toBe(true);
  });

  it('accepts when one of several rotated signatures matches', () => {
    const header = `v1=deadbeef,${sign(body)},v1=cafef00d`;
    expect(verifyPagerDutySignature(SECRET, body, header)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyPagerDutySignature(SECRET, body + 'x', sign(body))).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyPagerDutySignature(SECRET, body, sign(body, 'other-secret'))).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyPagerDutySignature(SECRET, body, 'not-a-signature')).toBe(false);
    expect(verifyPagerDutySignature(SECRET, body, '')).toBe(false);
    expect(verifyPagerDutySignature(SECRET, body, 'v2=' + 'a'.repeat(64))).toBe(false);
  });
});

describe('AlertSchema', () => {
  const valid = {
    incident_id: 'INC-2026-0803-001',
    title: 'Checkout 5xx spike',
    alert_source: 'pagerduty',
    started_at: '2026-08-03T12:00:00.000Z',
    affected_services: ['checkout', 'payments'],
    raw: { foo: 'bar' },
  };

  it('accepts a valid alert', () => {
    expect(AlertSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an incident_id with unsafe characters', () => {
    expect(AlertSchema.safeParse({ ...valid, incident_id: '../../etc/passwd' }).success).toBe(false);
    expect(AlertSchema.safeParse({ ...valid, incident_id: 'a b c' }).success).toBe(false);
  });

  it('rejects an unknown alert_source', () => {
    expect(AlertSchema.safeParse({ ...valid, alert_source: 'datadog' }).success).toBe(false);
  });

  it('rejects a non-datetime started_at', () => {
    expect(AlertSchema.safeParse({ ...valid, started_at: 'yesterday' }).success).toBe(false);
  });

  it('rejects a missing raw field', () => {
    const { raw, ...withoutRaw } = valid;
    expect(AlertSchema.safeParse(withoutRaw).success).toBe(false);
  });

  it('rejects more than 50 affected services', () => {
    const services = Array.from({ length: 51 }, (_, i) => `svc-${i}`);
    expect(AlertSchema.safeParse({ ...valid, affected_services: services }).success).toBe(false);
  });

  it('rejects a non-URL link href', () => {
    expect(
      AlertSchema.safeParse({ ...valid, links: [{ href: 'javascript:alert(1)', text: 'x' }] }).success
    ).toBe(false);
  });
});
