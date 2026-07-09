import { Pool } from 'pg';

// Shared pool for dashboard server components and API routes
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface IncidentRow {
  incident_id: string;
  title: string;
  severity: string;
  status: string;
  affected_services: string[];
  alert_source: string;
  started_at: string;
  resolved_at: string | null;
  created_at: string;
}

export interface RunbookStepRow {
  id: string;
  incident_id: string;
  step_number: number;
  action: string;
  command: string | null;
  tool: string;
  risk_level: string;
  requires_approval: boolean;
  status: string;
  result: string | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  incident_id: string;
  step_id: string;
  requested_at: string;
  decided_at: string | null;
  decision: string | null;
  decided_by: string | null;
  timeout_seconds: number;
}

export interface AgentLogRow {
  agent_role: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  timestamp: string;
  error: string | null;
}

export async function getIncidents(): Promise<IncidentRow[]> {
  const result = await pool.query<IncidentRow>(
    `SELECT incident_id, title, severity, status, affected_services,
            alert_source, started_at, resolved_at, created_at
     FROM incidents ORDER BY created_at DESC LIMIT 50`
  );
  return result.rows;
}

export async function getIncident(incidentId: string): Promise<IncidentRow | null> {
  const result = await pool.query<IncidentRow>(
    `SELECT * FROM incidents WHERE incident_id = $1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getRunbookSteps(incidentId: string): Promise<RunbookStepRow[]> {
  const result = await pool.query<RunbookStepRow>(
    `SELECT * FROM incident_runbook_steps WHERE incident_id = $1 ORDER BY step_number`,
    [incidentId]
  );
  return result.rows;
}

export async function getPendingApprovals(incidentId: string): Promise<ApprovalRow[]> {
  const result = await pool.query<ApprovalRow>(
    `SELECT ar.* FROM approval_requests ar
     WHERE ar.incident_id = $1 AND ar.decision IS NULL
     ORDER BY ar.requested_at`,
    [incidentId]
  );
  return result.rows;
}

export async function getApproval(stepId: string): Promise<ApprovalRow | null> {
  const result = await pool.query<ApprovalRow>(
    `SELECT * FROM approval_requests WHERE step_id = $1`,
    [stepId]
  );
  return result.rows[0] ?? null;
}

export async function decideApproval(
  stepId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<void> {
  await pool.query(
    `UPDATE approval_requests
     SET decision = $1, decided_by = $2, decided_at = NOW()
     WHERE step_id = $3 AND decision IS NULL`,
    [decision, decidedBy, stepId]
  );
  if (decision === 'approved') {
    await pool.query(
      `UPDATE incident_runbook_steps SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2`,
      [decidedBy, stepId]
    );
  } else {
    await pool.query(
      `UPDATE incident_runbook_steps SET status = 'skipped' WHERE id = $1`,
      [stepId]
    );
  }
}

export async function getAgentLogs(incidentId: string): Promise<AgentLogRow[]> {
  const result = await pool.query<AgentLogRow>(
    `SELECT agent_role, model, input_tokens, output_tokens, duration_ms, timestamp, error
     FROM agent_logs WHERE incident_id = $1 ORDER BY timestamp`,
    [incidentId]
  );
  return result.rows;
}

export async function getTriageSummary(incidentId: string) {
  const result = await pool.query(
    `SELECT severity, blast_radius, customer_impact, confidence
     FROM incident_triage WHERE incident_id = $1 LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getTopHypothesis(incidentId: string) {
  const result = await pool.query(
    `SELECT hypothesis, confidence, category, supporting_evidence
     FROM incident_hypotheses WHERE incident_id = $1 ORDER BY rank LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getPostmortem(incidentId: string) {
  const result = await pool.query(
    `SELECT root_cause, customer_impact, detection_gap, draft_markdown, github_issue_url, created_at
     FROM incident_postmortems WHERE incident_id = $1 LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getAllApprovals(incidentId: string): Promise<ApprovalRow[]> {
  const result = await pool.query<ApprovalRow>(
    `SELECT ar.* FROM approval_requests ar
     WHERE ar.incident_id = $1 ORDER BY ar.requested_at`,
    [incidentId]
  );
  return result.rows;
}
