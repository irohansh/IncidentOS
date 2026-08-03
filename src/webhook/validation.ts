import crypto from 'crypto';
import { z } from 'zod';

export const AlertSchema = z.object({
  incident_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  title:           z.string().min(1).max(500),
  alert_source:    z.enum(['pagerduty', 'grafana', 'prometheus', 'custom']),
  severity_hint:   z.string().optional(),
  affected_services: z.array(z.string().max(100)).max(50).optional(),
  metric_name:     z.string().max(200).optional(),
  metric_value:    z.number().optional(),
  threshold:       z.number().optional(),
  started_at:      z.string().datetime(),
  // http/https only — z.url() otherwise allows javascript:/data: (XSS via rendered links).
  links:           z.array(z.object({
    href: z.string().url().refine((v) => /^https?:\/\//i.test(v), 'href must be http(s)'),
    text: z.string().max(200),
  })).optional(),
  raw:             z.record(z.string(), z.unknown()),
});

export type ValidatedAlert = z.infer<typeof AlertSchema>;

// PagerDuty v1 HMAC-SHA256 header: "v1=<hex>,v1=<hex>,..." — any valid signature passes.
export function verifyPagerDutySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
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
