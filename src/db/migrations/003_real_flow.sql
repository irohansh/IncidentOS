-- Migration 003: real-flow columns and tables
-- Idempotent: safe to re-run.

-- incidents: relax severity NOT NULL, expand status CHECK, add new columns
ALTER TABLE incidents ALTER COLUMN severity DROP NOT NULL;

DO $$ BEGIN
  -- Recreate the status CHECK constraint to include new states.
  ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check;
  ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
    CHECK (status IN (
      'processing','active','awaiting_approval','mitigated',
      'resolved','unresolved','escalated','postmortem'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS state JSONB;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS slack_channel TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS slack_thread_ts TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS pagerduty_incident_id TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS github_issue_url TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS execution_modes TEXT[];
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS external_source TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS external_id TEXT;

-- incident_jobs: durable job queue (Postgres, no Redis)
CREATE TABLE IF NOT EXISTS incident_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT UNIQUE NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incident_jobs_status_run ON incident_jobs (status, run_after);

-- incident_runbook_steps: new columns
ALTER TABLE incident_runbook_steps ADD COLUMN IF NOT EXISTS rollback_command TEXT;
ALTER TABLE incident_runbook_steps ADD COLUMN IF NOT EXISTS execution_mode TEXT;
ALTER TABLE incident_runbook_steps ADD COLUMN IF NOT EXISTS command_sha256 TEXT;
ALTER TABLE incident_runbook_steps ADD COLUMN IF NOT EXISTS title TEXT;

-- approval_requests: new columns
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS command TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS rollback_command TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS risk_level TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS command_sha256 TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS execution_mode TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_via TEXT
  CHECK (decided_via IN ('dashboard','slack','system'));
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS slack_message_ts TEXT;

-- incident_postmortems: UNIQUE(incident_id) for safe upsert
DO $$ BEGIN
  ALTER TABLE incident_postmortems ADD CONSTRAINT incident_postmortems_incident_id_key
    UNIQUE (incident_id);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- audit_log: security audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor);

-- schema_migrations: track applied migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('003') ON CONFLICT DO NOTHING;
