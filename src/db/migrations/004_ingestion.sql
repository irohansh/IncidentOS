-- P1 — Real incident ingestion
-- Durable record of every received webhook event + duplicate-event protection.
-- Idempotent: safe to re-run.

-- Every accepted webhook delivery is recorded here. The UNIQUE dedup_key is what prevents
-- a duplicate/re-delivered webhook from starting a second incident workflow: the first
-- delivery wins the INSERT; later ones hit the conflict and are treated as duplicates.
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key TEXT UNIQUE NOT NULL,
  incident_id TEXT NOT NULL,
  event_type TEXT,
  source TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_incident ON webhook_events(incident_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);
