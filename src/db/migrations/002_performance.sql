-- Migration 002: performance indexes and data integrity improvements
-- Idempotent — safe to re-run.

-- Composite index for approval polling (hot path: approvalGate polls this every 3s)
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON approval_requests (incident_id, step_id)
  WHERE decision IS NULL;

-- Speed up dashboard queries that sort by severity + status
CREATE INDEX IF NOT EXISTS idx_incidents_severity_status
  ON incidents (severity, status);

-- Speed up most-recent-incidents query used by dashboard list page
CREATE INDEX IF NOT EXISTS idx_incidents_created_at
  ON incidents (created_at DESC);

-- Speed up hypothesis ranking queries
CREATE INDEX IF NOT EXISTS idx_hypotheses_incident_rank
  ON incident_hypotheses (incident_id, rank);

-- Speed up agent log queries filtered by incident (already exists, adding covering index)
CREATE INDEX IF NOT EXISTS idx_agent_logs_incident_ts
  ON agent_logs (incident_id, timestamp);

-- Partial index: only active incidents need fast status lookups
CREATE INDEX IF NOT EXISTS idx_incidents_active
  ON incidents (created_at DESC)
  WHERE status IN ('active', 'mitigated');

-- Ensure step approval uniqueness: only one pending approval per step at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_step_unique
  ON approval_requests (step_id)
  WHERE decision IS NULL;
