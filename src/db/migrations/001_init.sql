-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Core incident record
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','mitigated','resolved','postmortem')),
  affected_services TEXT[] NOT NULL DEFAULT '{}',
  alert_source TEXT NOT NULL,
  alert_payload JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mitigated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- All agent call logs
CREATE TABLE IF NOT EXISTS agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  agent_role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  batch_id TEXT,
  error TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Triage agent output
CREATE TABLE IF NOT EXISTS incident_triage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  severity TEXT NOT NULL,
  affected_services TEXT[] NOT NULL,
  blast_radius TEXT NOT NULL,
  customer_impact TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  raw_output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Root cause hypotheses
CREATE TABLE IF NOT EXISTS incident_hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  rank INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  supporting_evidence TEXT[] NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runbook steps selected and their status
CREATE TABLE IF NOT EXISTS incident_runbook_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  step_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  command TEXT,
  tool TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('safe','low','medium','high','critical')),
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','executing','done','failed','skipped')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Human approval queue
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  step_id UUID NOT NULL REFERENCES incident_runbook_steps(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decision TEXT CHECK (decision IN ('approved','rejected','timeout')),
  decided_by TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 300
);

-- Comms drafts
CREATE TABLE IF NOT EXISTS incident_comms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  audience TEXT NOT NULL CHECK (audience IN ('internal','customer','executive','status_page')),
  draft TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validator results per action
CREATE TABLE IF NOT EXISTS incident_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  step_id UUID NOT NULL REFERENCES incident_runbook_steps(id),
  resolved BOOLEAN NOT NULL,
  metrics_before JSONB,
  metrics_after JSONB,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Final postmortem
CREATE TABLE IF NOT EXISTS incident_postmortems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  timeline JSONB NOT NULL,
  root_cause TEXT NOT NULL,
  contributing_factors TEXT[] NOT NULL,
  customer_impact TEXT NOT NULL,
  detection_gap TEXT NOT NULL,
  action_items JSONB NOT NULL,
  five_whys JSONB NOT NULL,
  draft_markdown TEXT NOT NULL,
  github_issue_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes (IF NOT EXISTS so re-runs are safe)
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_agent_logs_incident ON agent_logs(incident_id);
CREATE INDEX IF NOT EXISTS idx_runbook_steps_incident ON incident_runbook_steps(incident_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_incident ON approval_requests(incident_id);
