export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type IncidentStatus =
  | 'active'
  | 'mitigated'
  | 'resolved'
  | 'postmortem';
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';
export type StepStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'skipped';
export type Audience =
  | 'internal'
  | 'customer'
  | 'executive'
  | 'status_page';

// Raw alert from PagerDuty or custom webhook
export interface AlertPayload {
  incident_id: string;
  title: string;
  alert_source: 'pagerduty' | 'grafana' | 'prometheus' | 'custom';
  severity_hint?: string;
  affected_services?: string[];
  metric_name?: string;
  metric_value?: number;
  threshold?: number;
  started_at: string;
  links?: { href: string; text: string }[];
  raw: Record<string, unknown>;
}

// Metrics snapshot fetched from Prometheus/Grafana
export interface MetricsSnapshot {
  fetched_at: string;
  error_rate_5m?: number;
  p99_latency_ms?: number;
  request_rate?: number;
  cpu_usage_percent?: number;
  memory_usage_percent?: number;
  pod_restart_count?: number;
  db_connection_pool_usage?: number;
  grafana_active_alerts?: number;
  grafana_annotations?: string[];
  custom: Record<string, number>;
}

// Triage agent output
export interface TriageOutput {
  incident_id: string;
  severity: Severity;
  affected_services: string[];
  blast_radius: string;
  customer_impact: string;
  internal_impact: string;
  confidence: number;
  needs_escalation: boolean;
  escalation_reason?: string;
  recommended_ic: string;
  war_room_needed: boolean;
  metrics_snapshot: MetricsSnapshot;
}

// Root cause agent output
export interface Hypothesis {
  rank: number;
  hypothesis: string;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  confidence: number;
  category:
    | 'deployment'
    | 'infrastructure'
    | 'database'
    | 'external_dependency'
    | 'traffic_spike'
    | 'configuration'
    | 'bug'
    | 'unknown';
  investigation_commands: string[];
}

export interface RootCauseOutput {
  incident_id: string;
  hypotheses: Hypothesis[];
  top_hypothesis: Hypothesis;
  recent_deploys: RecentDeploy[];
  correlated_events: string[];
  investigation_summary: string;
  confidence: number;
}

export interface RecentDeploy {
  sha: string;
  message: string;
  author: string;
  deployed_at: string;
  services_affected: string[];
  risk_assessment: 'low' | 'medium' | 'high';
}

// Comms agent output
export interface CommsOutput {
  incident_id: string;
  drafts: CommsDraft[];
  suggested_severity_label: string;
  do_not_say: string[];
}

export interface CommsDraft {
  audience: Audience;
  subject?: string;
  body: string;
  send_after_minutes: number;
  tone: 'urgent' | 'informational' | 'reassuring' | 'technical';
}

// Runbook agent output
export interface RunbookStep {
  step_number: number;
  title: string;
  action: string;
  rationale: string;
  command?: string;
  tool: 'kubectl' | 'docker' | 'postgres' | 'redis-cli' | 'bash' | 'api_call' | 'manual' | 'slack';
  risk_level: RiskLevel;
  requires_approval: boolean;
  rollback_command?: string;
  expected_outcome: string;
  timeout_seconds: number;
}

export interface RunbookOutput {
  incident_id: string;
  runbook_title: string;
  runbook_source: 'library' | 'generated' | 'hybrid';
  matched_runbook_id?: string;
  steps: RunbookStep[];
  estimated_resolution_minutes: number;
  confidence: number;
  caveat?: string;
}

// Executor agent output (per step)
export interface ExecutorOutput {
  incident_id: string;
  step_number: number;
  action_taken: string;
  command_executed?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms: number;
  success: boolean;
  error?: string;
  next_step_recommendation: 'proceed' | 'wait_and_validate' | 'abort' | 'escalate';
}

// Validator agent output (per step)
export interface ValidatorOutput {
  incident_id: string;
  step_number: number;
  resolved: boolean;
  metrics_before: MetricsSnapshot;
  metrics_after: MetricsSnapshot;
  improvement_percent?: number;
  confidence: number;
  verdict: 'resolved' | 'improving' | 'no_change' | 'degraded';
  recommendation: 'mark_resolved' | 'continue_runbook' | 'rollback' | 'escalate';
  notes: string;
}

// Postmortem agent output
export interface TimelineEvent {
  timestamp: string;
  event: string;
  actor: 'system' | 'agent' | 'human';
  significance: 'detection' | 'escalation' | 'action' | 'mitigation' | 'resolution';
}

export interface ActionItem {
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  owner_role: string;
  due_days: number;
  category: 'monitoring' | 'automation' | 'process' | 'infrastructure' | 'code';
}

export interface FiveWhy {
  why_number: number;
  question: string;
  answer: string;
}

export interface PostmortemOutput {
  incident_id: string;
  title: string;
  severity: Severity;
  duration_minutes: number;
  timeline: TimelineEvent[];
  root_cause: string;
  contributing_factors: string[];
  customer_impact: string;
  detection_gap: string;
  what_went_well: string[];
  what_went_poorly: string[];
  five_whys: FiveWhy[];
  action_items: ActionItem[];
  draft_markdown: string;
  github_issue_title: string;
  github_issue_body: string;
  github_issue_url?: string;
}

// Full incident state threaded through the pipeline
export interface IncidentState {
  alert: AlertPayload;
  triage?: TriageOutput;
  root_cause?: RootCauseOutput;
  comms?: CommsOutput;
  runbook?: RunbookOutput;
  executor_results: ExecutorOutput[];
  validator_results: ValidatorOutput[];
  postmortem?: PostmortemOutput;
  started_at: string;
  timeline: TimelineEvent[];
}

export interface AgentLog {
  incident_id: string;
  agent_role: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  error?: string;
  timestamp: string;
}
