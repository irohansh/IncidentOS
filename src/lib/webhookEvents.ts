import type { QueryResult, QueryResultRow } from 'pg';
import { query } from './db';
import { logger } from './logger';
import type { AlertPayload } from '../types/incident';

// Injectable for unit tests (no DB needed).
export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

/**
 * The key used to collapse duplicate deliveries into a single workflow. PagerDuty (and
 * most alert sources) re-deliver the same logical event on retry; they may also send
 * multiple lifecycle events (triggered/acknowledged/resolved) for one incident. We key on
 * a caller-provided dedup id when present, otherwise the normalized incident_id — so one
 * incident starts exactly one investigation pipeline.
 */
export function dedupKey(alert: AlertPayload): string {
  const raw = alert.raw as Record<string, unknown> | undefined;
  const fromRaw =
    (raw?.dedup_key as string | undefined) ??
    ((raw?.event as Record<string, unknown> | undefined)?.id as string | undefined);
  return `${alert.alert_source}:${fromRaw ?? alert.incident_id}`;
}

export interface ClaimResult {
  firstDelivery: boolean;
  dedup_key: string;
}

/**
 * Atomically record the webhook event and decide whether this delivery should start a
 * pipeline. First writer wins: the INSERT ... ON CONFLICT DO NOTHING returns a row only for
 * the first delivery of a given dedup_key; duplicates get no row and are not processed.
 */
export async function claimWebhookEvent(
  alert: AlertPayload,
  opts: { eventType?: string; signatureVerified: boolean },
  q: QueryFn = query
): Promise<ClaimResult> {
  const key = dedupKey(alert);
  const res = await q<{ id: string }>(
    `INSERT INTO webhook_events (dedup_key, incident_id, event_type, source, signature_verified, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      key,
      alert.incident_id,
      opts.eventType ?? null,
      alert.alert_source,
      opts.signatureVerified,
      JSON.stringify(alert.raw ?? {}),
    ]
  );
  const firstDelivery = res.rows.length > 0;
  if (!firstDelivery) {
    logger.info('Duplicate webhook event — not starting a second workflow', {
      incident_id: alert.incident_id, dedup_key: key,
    });
  }
  return { firstDelivery, dedup_key: key };
}
