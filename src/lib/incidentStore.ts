import type {
  AlertPayload,
  AgentLog,
  TriageOutput,
  RootCauseOutput,
  CommsOutput,
  RunbookStep,
  ValidatorOutput,
  PostmortemOutput,
} from '../types/incident';
import { query } from './db';

// Insert an incident stub immediately when the webhook arrives (before pipeline runs).
// Used by the webhook server to claim the incident before enqueuing a job.
export async function saveIncidentStub(alert: AlertPayload): Promise<void> {
  await query(
    `INSERT INTO incidents
       (incident_id, title, severity, affected_services, alert_source, alert_payload, started_at, status)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'processing')
     ON CONFLICT (incident_id) DO NOTHING`,
    [
      alert.incident_id,
      alert.title,
      alert.affected_services ?? [],
      alert.alert_source,
      JSON.stringify(alert.raw),
      alert.started_at,
    ]
  );
}

export async function enqueueJob(incidentId: string): Promise<void> {
  await query(
    `INSERT INTO incident_jobs (incident_id)
     VALUES ($1)
     ON CONFLICT (incident_id) DO NOTHING`,
    [incidentId]
  );
}

export async function saveIncident(alert: AlertPayload, triage: TriageOutput): Promise<void> {
  await query(
    `INSERT INTO incidents
       (incident_id, title, severity, affected_services, alert_source, alert_payload, started_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     ON CONFLICT (incident_id) DO UPDATE
       SET severity = EXCLUDED.severity,
           affected_services = EXCLUDED.affected_services,
           status = 'active'`,
    [
      alert.incident_id,
      alert.title,
      triage.severity,
      triage.affected_services,
      alert.alert_source,
      JSON.stringify(alert.raw),
      alert.started_at,
    ]
  );
}

export async function saveAgentLog(log: AgentLog): Promise<void> {
  await query(
    `INSERT INTO agent_logs
       (incident_id, agent_role, model, input_tokens, output_tokens, duration_ms, error, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      log.incident_id,
      log.agent_role,
      log.model,
      log.input_tokens,
      log.output_tokens,
      log.duration_ms,
      log.error ?? null,
      log.timestamp,
    ]
  );
}

export async function saveTriage(incidentId: string, triage: TriageOutput): Promise<void> {
  await query(
    `INSERT INTO incident_triage
       (incident_id, severity, affected_services, blast_radius, customer_impact, confidence, raw_output)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      incidentId,
      triage.severity,
      triage.affected_services,
      triage.blast_radius,
      triage.customer_impact,
      triage.confidence,
      JSON.stringify(triage),
    ]
  );
}

export async function saveHypotheses(incidentId: string, output: RootCauseOutput): Promise<void> {
  for (const h of output.hypotheses) {
    await query(
      `INSERT INTO incident_hypotheses
         (incident_id, rank, hypothesis, supporting_evidence, confidence, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [incidentId, h.rank, h.hypothesis, h.supporting_evidence, h.confidence, h.category]
    );
  }
}

export async function saveComms(incidentId: string, output: CommsOutput): Promise<void> {
  for (const draft of output.drafts) {
    await query(
      `INSERT INTO incident_comms (incident_id, audience, draft)
       VALUES ($1, $2, $3)`,
      [incidentId, draft.audience, draft.body]
    );
  }
}

// Returns a map of step_number → UUID so approval_requests can reference them
export async function saveRunbookSteps(
  incidentId: string,
  steps: RunbookStep[]
): Promise<Map<number, string>> {
  const stepIdMap = new Map<number, string>();
  for (const step of steps) {
    const result = await query<{ id: string }>(
      `INSERT INTO incident_runbook_steps
         (incident_id, step_number, action, command, tool, risk_level, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        incidentId,
        step.step_number,
        step.action,
        step.command ?? null,
        step.tool,
        step.risk_level,
        step.requires_approval,
      ]
    );
    stepIdMap.set(step.step_number, result.rows[0].id);
  }
  return stepIdMap;
}

export async function markStepExecuted(stepId: string, result: string): Promise<void> {
  await query(
    `UPDATE incident_runbook_steps
     SET status = 'done', executed_at = NOW(), result = $2
     WHERE id = $1`,
    [stepId, result]
  );
}

export async function saveValidation(
  incidentId: string,
  stepId: string,
  v: ValidatorOutput
): Promise<void> {
  await query(
    `INSERT INTO incident_validations
       (incident_id, step_id, resolved, metrics_before, metrics_after, confidence, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      incidentId,
      stepId,
      v.resolved,
      JSON.stringify(v.metrics_before),
      JSON.stringify(v.metrics_after),
      v.confidence,
      v.notes,
    ]
  );
}

export async function savePostmortem(
  incidentId: string,
  pm: PostmortemOutput
): Promise<void> {
  await query(
    `INSERT INTO incident_postmortems
       (incident_id, timeline, root_cause, contributing_factors, customer_impact,
        detection_gap, action_items, five_whys, draft_markdown, github_issue_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (incident_id) DO UPDATE
       SET timeline = EXCLUDED.timeline,
           root_cause = EXCLUDED.root_cause,
           github_issue_url = COALESCE(EXCLUDED.github_issue_url, incident_postmortems.github_issue_url)`,
    [
      incidentId,
      JSON.stringify(pm.timeline),
      pm.root_cause,
      pm.contributing_factors,
      pm.customer_impact,
      pm.detection_gap,
      JSON.stringify(pm.action_items),
      JSON.stringify(pm.five_whys),
      pm.draft_markdown,
      pm.github_issue_url ?? null,
    ]
  );

  await query(
    `UPDATE incidents SET status = 'postmortem', resolved_at = NOW()
     WHERE incident_id = $1`,
    [incidentId]
  );
}

export async function updateIncidentOutcome(
  incidentId: string,
  outcome: string
): Promise<void> {
  await query(
    `UPDATE incidents SET outcome = $1 WHERE incident_id = $2`,
    [outcome, incidentId]
  );
}

export async function updateIncidentStatus(
  incidentId: string,
  status: string
): Promise<void> {
  await query(
    `UPDATE incidents SET status = $1 WHERE incident_id = $2`,
    [status, incidentId]
  );
}
