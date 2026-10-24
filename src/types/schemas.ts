import { z } from 'zod';

// Zod v4 schemas mirroring src/types/incident.ts.
// TypeScript types are inferred from these schemas — single source of truth.

const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const RiskLevelSchema = z.enum(['safe', 'low', 'medium', 'high', 'critical']);

const MetricsSnapshotSchema = z.object({
  fetched_at: z.string(),
  error_rate_5m: z.number().optional(),
  p99_latency_ms: z.number().optional(),
  request_rate: z.number().optional(),
  cpu_usage_percent: z.number().optional(),
  memory_usage_percent: z.number().optional(),
  pod_restart_count: z.number().optional(),
  db_connection_pool_usage: z.number().optional(),
  grafana_active_alerts: z.number().optional(),
  grafana_annotations: z.array(z.string()).optional(),
  custom: z.record(z.string(), z.number()).default({}),
  integration_health: z.object({
    prometheus: z.enum(['ok', 'unavailable', 'not_configured']),
    grafana: z.enum(['ok', 'unavailable', 'not_configured']),
    prometheus_detail: z.string().optional(),
    grafana_detail: z.string().optional(),
    metrics_retrieved: z.array(z.string()).optional(),
  }).optional(),
});

export const TriageOutputSchema = z.object({
  incident_id: z.string(),
  severity: SeveritySchema,
  affected_services: z.array(z.string()),
  blast_radius: z.string(),
  customer_impact: z.string(),
  internal_impact: z.string(),
  confidence: z.number().min(0).max(100),
  needs_escalation: z.boolean(),
  escalation_reason: z.string().optional(),
  recommended_ic: z.string(),
  war_room_needed: z.boolean(),
  metrics_snapshot: MetricsSnapshotSchema,
});

const HypothesisSchema = z.object({
  rank: z.number(),
  hypothesis: z.string(),
  supporting_evidence: z.array(z.string()),
  contradicting_evidence: z.array(z.string()),
  confidence: z.number().min(0).max(100),
  category: z.enum([
    'deployment', 'infrastructure', 'database', 'external_dependency',
    'traffic_spike', 'configuration', 'bug', 'unknown',
  ]),
  investigation_commands: z.array(z.string()),
});

export const RootCauseOutputSchema = z.object({
  incident_id: z.string(),
  hypotheses: z.array(HypothesisSchema).min(1),
  top_hypothesis: HypothesisSchema,
  recent_deploys: z.array(z.object({
    sha: z.string(),
    message: z.string(),
    author: z.string(),
    deployed_at: z.string(),
    services_affected: z.array(z.string()),
    risk_assessment: z.enum(['low', 'medium', 'high']),
  })),
  correlated_events: z.array(z.string()),
  investigation_summary: z.string(),
  confidence: z.number().min(0).max(100),
});

export const CommsOutputSchema = z.object({
  incident_id: z.string(),
  drafts: z.array(z.object({
    audience: z.enum(['internal', 'customer', 'executive', 'status_page']),
    subject: z.string().optional(),
    body: z.string(),
    send_after_minutes: z.number(),
    tone: z.enum(['urgent', 'informational', 'reassuring', 'technical']),
  })),
  suggested_severity_label: z.string(),
  do_not_say: z.array(z.string()),
});

const RunbookStepSchema = z.object({
  step_number: z.number(),
  title: z.string(),
  action: z.string(),
  rationale: z.string(),
  command: z.string().optional(),
  tool: z.enum(['kubectl', 'docker', 'postgres', 'redis-cli', 'bash', 'api_call', 'manual', 'slack']),
  risk_level: RiskLevelSchema,
  requires_approval: z.boolean(),
  rollback_command: z.string().optional(),
  expected_outcome: z.string(),
  timeout_seconds: z.number(),
});

export const RunbookOutputSchema = z.object({
  incident_id: z.string(),
  runbook_title: z.string(),
  runbook_source: z.enum(['library', 'generated', 'hybrid']),
  matched_runbook_id: z.string().optional(),
  steps: z.array(RunbookStepSchema),
  estimated_resolution_minutes: z.number(),
  confidence: z.number().min(0).max(100),
  caveat: z.string().optional(),
}).superRefine((val, ctx) => {
  // Enforce requires_approval=true for medium+ risk regardless of AI output.
  val.steps.forEach((step, i) => {
    if (['medium', 'high', 'critical'].includes(step.risk_level) && !step.requires_approval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps', i, 'requires_approval'],
        message: `Step ${step.step_number} has risk_level "${step.risk_level}" but requires_approval=false — setting true`,
      });
    }
  });
});

export const ExecutorOutputSchema = z.object({
  incident_id: z.string(),
  step_number: z.number(),
  action_taken: z.string(),
  command_executed: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exit_code: z.number().optional(),
  duration_ms: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  next_step_recommendation: z.enum(['proceed', 'wait_and_validate', 'abort', 'escalate']),
  execution_mode: z.enum(['real', 'dry_run', 'simulated']),
});

export const ValidatorOutputSchema = z.object({
  incident_id: z.string(),
  step_number: z.number(),
  resolved: z.boolean(),
  metrics_before: MetricsSnapshotSchema,
  metrics_after: MetricsSnapshotSchema,
  improvement_percent: z.number().optional(),
  confidence: z.number().min(0).max(100),
  verdict: z.enum(['resolved', 'improving', 'no_change', 'degraded', 'unknown']),
  recommendation: z.enum(['mark_resolved', 'continue_runbook', 'rollback', 'escalate']),
  notes: z.string(),
});

const TimelineEventSchema = z.object({
  timestamp: z.string(),
  event: z.string(),
  actor: z.enum(['system', 'agent', 'human']),
  significance: z.enum(['detection', 'escalation', 'action', 'mitigation', 'resolution']),
});

const ActionItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(['P0', 'P1', 'P2']),
  owner_role: z.string(),
  due_days: z.number(),
  category: z.enum(['monitoring', 'automation', 'process', 'infrastructure', 'code']),
});

export const PostmortemOutputSchema = z.object({
  incident_id: z.string(),
  title: z.string(),
  severity: SeveritySchema,
  duration_minutes: z.number(),
  timeline: z.array(TimelineEventSchema),
  root_cause: z.string(),
  contributing_factors: z.array(z.string()),
  customer_impact: z.string(),
  detection_gap: z.string(),
  what_went_well: z.array(z.string()),
  what_went_poorly: z.array(z.string()),
  five_whys: z.array(z.object({
    why_number: z.number(),
    question: z.string(),
    answer: z.string(),
  })),
  action_items: z.array(ActionItemSchema),
  draft_markdown: z.string(),
  github_issue_title: z.string(),
  github_issue_body: z.string(),
  github_issue_url: z.string().optional(),
});

// Map from agent role to its Zod schema.
import type { AgentRole } from '../lib/callAgent';
import type { ZodTypeAny } from 'zod';

export const AGENT_SCHEMAS: Record<AgentRole, ZodTypeAny> = {
  triage:     TriageOutputSchema,
  rootCause:  RootCauseOutputSchema,
  comms:      CommsOutputSchema,
  runbook:    RunbookOutputSchema,
  executor:   ExecutorOutputSchema,
  validator:  ValidatorOutputSchema,
  postmortem: PostmortemOutputSchema,
};
