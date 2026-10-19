// All Postgres queries for the Next.js dashboard.
// Uses the shared retry-wrapped query() from lib/db — no separate pool here.
import { query } from '../../lib/db';

export interface IncidentRow {
  incident_id: string;
  title: string;
  severity: string | null;
  status: string;
  outcome: string | null;
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
  title: string | null;
  action: string;
  command: string | null;
  tool: string;
  risk_level: string;
  requires_approval: boolean;
  status: string;
  execution_mode: string | null;
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
  decided_via: string | null;
  expires_at: string | null;
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
  const result = await query<IncidentRow>(
    `SELECT incident_id, title, severity, status, outcome, affected_services,
            alert_source, started_at, resolved_at, created_at
     FROM incidents ORDER BY created_at DESC LIMIT 50`
  );
  return result.rows;
}

export async function getIncident(incidentId: string): Promise<IncidentRow | null> {
  const result = await query<IncidentRow>(
    `SELECT * FROM incidents WHERE incident_id = $1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getRunbookSteps(incidentId: string): Promise<RunbookStepRow[]> {
  const result = await query<RunbookStepRow>(
    `SELECT * FROM incident_runbook_steps WHERE incident_id = $1 ORDER BY step_number`,
    [incidentId]
  );
  return result.rows;
}

export async function getPendingApprovals(incidentId: string): Promise<ApprovalRow[]> {
  const result = await query<ApprovalRow>(
    `SELECT ar.* FROM approval_requests ar
     WHERE ar.incident_id = $1 AND ar.decision IS NULL
     ORDER BY ar.requested_at`,
    [incidentId]
  );
  return result.rows;
}

export async function getApproval(stepId: string): Promise<ApprovalRow | null> {
  const result = await query<ApprovalRow>(
    `SELECT * FROM approval_requests WHERE step_id = $1`,
    [stepId]
  );
  return result.rows[0] ?? null;
}

export async function decideApproval(
  stepId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<number> {
  const result = await query(
    `UPDATE approval_requests
     SET decision = $1, decided_by = $2, decided_at = NOW(), decided_via = 'dashboard'
     WHERE step_id = $3 AND decision IS NULL`,
    [decision, decidedBy, stepId]
  );
  if ((result.rowCount ?? 0) === 0) return 0;

  if (decision === 'approved') {
    await query(
      `UPDATE incident_runbook_steps SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2`,
      [decidedBy, stepId]
    );
  } else {
    await query(
      `UPDATE incident_runbook_steps SET status = 'skipped' WHERE id = $1`,
      [stepId]
    );
  }
  return result.rowCount ?? 0;
}

export async function getAgentLogs(incidentId: string): Promise<AgentLogRow[]> {
  const result = await query<AgentLogRow>(
    `SELECT agent_role, model, input_tokens, output_tokens, duration_ms, timestamp, error
     FROM agent_logs WHERE incident_id = $1 ORDER BY timestamp`,
    [incidentId]
  );
  return result.rows;
}

export async function getTriageSummary(incidentId: string) {
  const result = await query(
    `SELECT severity, blast_radius, customer_impact, confidence
     FROM incident_triage WHERE incident_id = $1 LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getTopHypothesis(incidentId: string) {
  const result = await query(
    `SELECT hypothesis, confidence, category, supporting_evidence
     FROM incident_hypotheses WHERE incident_id = $1 ORDER BY rank LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getPostmortem(incidentId: string) {
  const result = await query(
    `SELECT root_cause, customer_impact, detection_gap, draft_markdown, github_issue_url, created_at
     FROM incident_postmortems WHERE incident_id = $1 LIMIT 1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

export async function getAllApprovals(incidentId: string): Promise<ApprovalRow[]> {
  const result = await query<ApprovalRow>(
    `SELECT ar.* FROM approval_requests ar
     WHERE ar.incident_id = $1 ORDER BY ar.requested_at`,
    [incidentId]
  );
  return result.rows;
}
