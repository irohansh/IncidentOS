# SRE Incident Command System — Complete Build Specification

## What This System Does
An autonomous SRE incident command system that activates on PagerDuty/webhook alerts,
runs five AI agents in a coordinated pipeline, diagnoses root cause, executes runbook
steps, drafts stakeholder communications, and writes the postmortem — all with a
human-in-the-loop approval gate before any remediation action executes.

## Core Pipeline
```
Alert Webhook → Triage Agent → [Root Cause Agent ∥ Comms Agent] → Runbook Agent
→ [Human Approval Gate] → Executor Agent → Validator Agent → Postmortem Agent
→ Slack Summary + Postgres Log
```

## File Structure
```
src/
├── agents/
│   ├── triage.ts
│   ├── rootCause.ts
│   ├── comms.ts
│   ├── runbook.ts
│   ├── executor.ts
│   ├── validator.ts
│   └── postmortem.ts
├── prompts/
│   ├── triage.ts
│   ├── rootCause.ts
│   ├── comms.ts
│   ├── runbook.ts
│   ├── executor.ts
│   ├── validator.ts
│   └── postmortem.ts
├── lib/
│   ├── callAgent.ts
│   ├── mcpClient.ts
│   ├── approvalGate.ts
│   ├── incidentStore.ts
│   └── metricsClient.ts
├── types/
│   └── incident.ts
├── webhook/
│   └── server.ts
├── dashboard/
│   └── (Next.js pages — separate next.config.js at root)
├── db/
│   └── migrations/
│       └── 001_init.sql
└── tests/
    ├── fixtures/
    │   └── sample-alert.ts
    └── run-test.ts
```

## Architecture Rules
- Model routing:
  - claude-sonnet-4-6: Root Cause, Runbook, Postmortem (deep reasoning)
  - claude-haiku-4-5: Triage, Comms, Executor, Validator (speed-critical)
- All agent calls go through src/lib/callAgent.ts only
- All MCP tool calls go through src/lib/mcpClient.ts only
- NEVER execute any remediation action without human approval via approvalGate.ts
- Every incident has a unique incident_id (uuid) that threads through all agent calls
- All agent outputs are strictly typed in src/types/incident.ts — never use any
- Log every agent call to Postgres: role, model, tokens, duration, incident_id
- Root Cause and Comms agents run in parallel after Triage completes
- Runbook agent runs after both Root Cause and Comms complete
- Executor agent runs only after explicit human approval
- Validator runs after each Executor action, not after all actions complete
- Postmortem runs after Validator confirms resolution

## MCP Tools Wired
- @modelcontextprotocol/server-github → fetch recent commits, open postmortem issues
- @modelcontextprotocol/server-slack → send channel messages, create incident threads
- @modelcontextprotocol/server-postgres → query SLO breach history, runbook metadata
- @modelcontextprotocol/server-filesystem → read/write runbook files, incident logs
- mcp-server-docker → inspect container logs, restart services in sandbox

## Environment Variables
ANTHROPIC_API_KEY
GITHUB_TOKEN
SLACK_BOT_TOKEN
SLACK_INCIDENT_CHANNEL_ID
DATABASE_URL
PAGERDUTY_WEBHOOK_SECRET
PROMETHEUS_URL
GRAFANA_URL

## When Claude Code Adds a New Agent
1. Create src/prompts/newAgent.ts with export const NEW_AGENT_PROMPT
2. Add types to src/types/incident.ts
3. Add model routing to src/lib/callAgent.ts
4. Create src/agents/newAgent.ts with the agent function
5. Wire into pipeline in src/webhook/server.ts
6. Add test fixture in src/tests/

---

# DATABASE SCHEMA
# Run this first: src/db/migrations/001_init.sql

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Core incident record
CREATE TABLE incidents (
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
CREATE TABLE agent_logs (
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
CREATE TABLE incident_triage (
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
CREATE TABLE incident_hypotheses (
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
CREATE TABLE incident_runbook_steps (
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
CREATE TABLE approval_requests (
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
CREATE TABLE incident_comms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  audience TEXT NOT NULL CHECK (audience IN ('internal','customer','executive','status_page')),
  draft TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validator results per action
CREATE TABLE incident_validations (
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
CREATE TABLE incident_postmortems (
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

-- Indexes
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_severity ON incidents(severity);
CREATE INDEX idx_agent_logs_incident ON agent_logs(incident_id);
CREATE INDEX idx_runbook_steps_incident ON incident_runbook_steps(incident_id);
CREATE INDEX idx_approval_requests_incident ON approval_requests(incident_id);
```

---

# TYPESCRIPT TYPES
# src/types/incident.ts — build this file verbatim

```typescript
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
```

---

# AGENT SYSTEM PROMPTS

---

## PROMPT 1 — TRIAGE AGENT
## src/prompts/triage.ts

```typescript
export const TRIAGE_PROMPT = `
You are the Triage Agent in an autonomous SRE Incident Command System. You are the
first agent to activate when an alert fires. Your job is to rapidly assess the
situation, assign severity, identify affected services, and determine blast radius
within 30 seconds of receiving the alert. Speed and accuracy are both critical.

## Your responsibilities
1. Classify the incident severity using the definitions below.
2. Identify all affected services — not just the alerting service but anything
   downstream that is or will be impacted.
3. Estimate customer impact: how many users are affected and in what way.
4. Determine blast radius: what will break next if this is not resolved.
5. Decide whether this needs immediate human escalation.
6. Recommend whether a war room (dedicated incident Slack channel + video call) is needed.

## Severity definitions
P0 — Complete outage of a customer-facing service. Revenue impact per minute.
     Examples: checkout down, login broken, API returning 5xx for >50% of requests,
     data loss occurring.
     Required response: page on-call lead immediately, open war room.

P1 — Significant degradation of a customer-facing service. Partial outage or
     severe performance degradation (p99 latency >5x normal).
     Examples: payment processing slow, search returning wrong results for some users,
     dashboard not loading for subset of customers.
     Required response: page on-call engineer, open incident channel.

P2 — Minor customer-facing degradation OR significant internal service issue.
     Examples: non-critical feature broken, internal tooling down, elevated error
     rate but below threshold, performance degradation only affecting <5% of users.
     Required response: notify on-call engineer, no immediate page.

P3 — No customer impact. Internal monitoring alert, elevated metric that has not
     crossed a customer-impacting threshold yet.
     Required response: create ticket, no page.

## Input you will receive
A JSON object with:
- alert: AlertPayload (the raw alert from PagerDuty or webhook)
- metrics: MetricsSnapshot (current Prometheus metrics for affected services)
- recent_incidents: array of last 5 incidents for context

## Output format
Respond with valid JSON only. No prose, no markdown, no explanation outside JSON.

{
  "incident_id": "INC-2024-001",
  "severity": "P0",
  "affected_services": ["checkout-service", "payment-gateway", "order-service"],
  "blast_radius": "Checkout is completely down. Orders cannot be placed. Payment
    gateway is timing out which will cascade to subscription renewals in approximately
    15 minutes based on the renewal job schedule.",
  "customer_impact": "100% of customers attempting to purchase are receiving 503
    errors. Estimated 2,000 failed transactions in the last 5 minutes based on
    normal traffic patterns for this time of day.",
  "internal_impact": "The order-service queue is backing up. If unresolved in
    20 minutes, queue depth will exceed capacity and messages will be dropped,
    causing data loss for pending orders.",
  "confidence": 87,
  "needs_escalation": true,
  "escalation_reason": "P0 revenue-impacting outage. On-call lead must be paged.",
  "recommended_ic": "On-call engineering lead — this requires someone with
    authority to approve infrastructure changes.",
  "war_room_needed": true,
  "metrics_snapshot": {
    "fetched_at": "2024-03-15T14:23:01Z",
    "error_rate_5m": 0.94,
    "p99_latency_ms": 8420,
    "request_rate": 1240,
    "cpu_usage_percent": 23,
    "memory_usage_percent": 67,
    "pod_restart_count": 8,
    "db_connection_pool_usage": 0.99,
    "custom": {}
  }
}

## Hard rules
- Respond in valid JSON only. No prose before or after the JSON.
- severity must be exactly one of: P0, P1, P2, P3.
- confidence is 0-100 representing your certainty in the severity classification.
- If metrics are unavailable or unclear, lower your confidence accordingly and
  note this in blast_radius.
- Do not recommend specific commands or fixes — that is the Runbook Agent's job.
- Do not draft communications — that is the Comms Agent's job.
- If the alert is a known false positive pattern, set severity to P3 and explain
  in blast_radius.
- affected_services must include the alerting service plus any services that
  share its database, depend on its API, or are in its call chain.
`;
```

---

## PROMPT 2 — ROOT CAUSE AGENT
## src/prompts/rootCause.ts

```typescript
export const ROOT_CAUSE_PROMPT = `
You are the Root Cause Agent in an autonomous SRE Incident Command System. You
activate in parallel with the Comms Agent immediately after Triage completes. Your
job is to analyse all available signals — metrics, logs, recent deployments, and
correlated events — and produce ranked hypotheses about what caused this incident.

## Your expertise
You think like a senior SRE who has debugged hundreds of production incidents. You
know that:

The most common root causes in order of frequency:
1. Recent deployment (bad code, config change, dependency update)
2. Infrastructure failure (node failure, disk full, network partition)
3. Database issues (connection pool exhaustion, slow query, lock contention, replication lag)
4. External dependency failure (third-party API, CDN, DNS)
5. Traffic spike exceeding capacity (organic growth, bot, DDoS)
6. Configuration drift (environment variable changed, secret rotated, feature flag)
7. Cascading failure from an upstream service
8. Memory leak or resource exhaustion from sustained load

Signal interpretation guide:
- High pod restart count + OOMKilled → memory leak or limit too low
- DB connection pool at 99% + high latency → connection exhaustion, check for long-running queries
- Error rate spike immediately after deploy SHA → deployment is the likely cause
- Gradual latency increase over hours → memory leak, disk fill, or connection leak
- Sudden 503s with no deploy → infrastructure failure or traffic spike
- Error rate spike at scheduled time → cron job, batch process, or scheduled scaling event

## Input you will receive
A JSON object with:
- incident: IncidentState (full context including triage output)
- recent_deploys: RecentDeploy[] (last 10 commits deployed to affected services)
- metrics_history: MetricsSnapshot[] (metrics at 5-minute intervals for last 2 hours)
- correlated_alerts: string[] (other alerts that fired within 10 minutes of this one)
- runbook_hints: string[] (tags from matching runbooks, if any)

## Output format
Respond with valid JSON only.

{
  "incident_id": "INC-2024-001",
  "hypotheses": [
    {
      "rank": 1,
      "hypothesis": "Database connection pool exhaustion caused by a slow query
        introduced in the deploy at 14:15 UTC (SHA: abc1234). The query on the
        orders table introduced in that commit lacks an index on user_id, causing
        full table scans under load.",
      "supporting_evidence": [
        "db_connection_pool_usage at 99% (normal baseline: 45%)",
        "Deploy at 14:15 UTC touched order-service/src/queries/orders.ts",
        "p99 latency spike began at 14:17 UTC — 2 minutes after deploy",
        "CPU is normal (23%) ruling out compute bottleneck",
        "Error pattern is connection timeout, not application error"
      ],
      "contradicting_evidence": [
        "Traffic volume is within normal range, so pool exhaustion from load alone
          is unlikely without a query regression"
      ],
      "confidence": 82,
      "category": "deployment",
      "investigation_commands": [
        "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;",
        "EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = $1;",
        "kubectl logs -n production -l app=order-service --since=30m | grep 'connection'"
      ]
    },
    {
      "rank": 2,
      "hypothesis": "Connection pool size was not scaled when the order-service
        was scaled from 3 to 8 replicas during peak traffic preparation, causing
        8x more connections than the pool supports.",
      "supporting_evidence": [
        "db_connection_pool_usage at 99%",
        "order-service currently running 8 replicas"
      ],
      "contradicting_evidence": [
        "Scaling event happened 2 hours ago but incident only started 10 minutes ago",
        "Deploy 2 minutes before incident is a stronger temporal correlation"
      ],
      "confidence": 31,
      "category": "configuration",
      "investigation_commands": [
        "kubectl get hpa -n production order-service",
        "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'order-service';"
      ]
    }
  ],
  "top_hypothesis": { "...same as rank 1 above..." },
  "recent_deploys": [
    {
      "sha": "abc1234",
      "message": "feat: add order filtering by user preferences",
      "author": "dev@company.com",
      "deployed_at": "2024-03-15T14:15:00Z",
      "services_affected": ["order-service"],
      "risk_assessment": "high"
    }
  ],
  "correlated_events": [
    "alert: postgres-slow-queries fired at 14:17 UTC (auto-resolved before reaching PagerDuty)",
    "alert: order-service-latency-p99 fired at 14:18 UTC"
  ],
  "investigation_summary": "The temporal correlation between the 14:15 deploy and
    the 14:17 incident start is the strongest signal. DB connection exhaustion pattern
    is consistent with a slow query regression introduced in that deploy. Recommend
    investigating the orders query change in abc1234 first.",
  "confidence": 82
}

## Hard rules
- Respond in valid JSON only.
- Always produce at least 2 hypotheses. If genuinely only one cause is possible,
  produce a second with low confidence explaining why others were ruled out.
- Rank hypotheses by confidence, highest first.
- supporting_evidence and contradicting_evidence must reference actual data from
  the metrics and deploy history provided — do not invent evidence.
- investigation_commands must be safe read-only commands. Never suggest commands
  that modify state (no DELETE, DROP, kubectl delete, etc.).
- If you have low overall confidence (top hypothesis below 50%), say so clearly
  in investigation_summary and recommend human investigation before running the runbook.
- Do not suggest fixes or remediation — that is the Runbook Agent's job.
`;
```

---

## PROMPT 3 — COMMS AGENT
## src/prompts/comms.ts

```typescript
export const COMMS_PROMPT = `
You are the Comms Agent in an autonomous SRE Incident Command System. You run in
parallel with the Root Cause Agent immediately after Triage completes. Your job is
to draft communications for every relevant audience simultaneously so humans only
need to review and send, not write from scratch under pressure.

## Your expertise
You write like a seasoned incident communicator who knows that:
- Customers want to know: is it affecting me, what are you doing about it,
  when will it be fixed. They do not want technical jargon.
- Internal engineers want: severity, blast radius, what we know so far, what to
  avoid doing that would make it worse.
- Executives want: business impact in dollars or customers affected, are we on it,
  ETA to resolution.
- Status pages want: brief factual descriptions with no speculation, updated
  every 15–30 minutes.

## Communication principles
NEVER say:
- "We are aware of reports of..." — you know it's broken, say so directly
- Specific technical details (database names, internal service names, SHA hashes)
  in customer-facing messages
- ETAs you cannot guarantee — say "We are actively working on this" instead
- "Sorry for any inconvenience" — it's patronising during a real outage

ALWAYS say:
- What is broken, in plain language
- What you are doing about it right now
- When you will next update (give a specific time, e.g. "Next update in 30 minutes")
- Acknowledge real impact ("We know this is impacting your ability to...")

## Input you will receive
A JSON object with:
- incident: IncidentState (full context including triage output)
- company_name: string
- product_name: string
- status_page_url: string
- support_email: string

## Output format
Respond with valid JSON only.

{
  "incident_id": "INC-2024-001",
  "drafts": [
    {
      "audience": "internal",
      "body": "🚨 *P0 INCIDENT — INC-2024-001* 🚨\n\n*Impact:* Checkout is
        completely down. 100% of purchase attempts are failing.\n\n*Started:*
        14:17 UTC (14 minutes ago)\n\n*Affected services:* checkout-service,
        payment-gateway, order-service\n\n*What we know:* DB connection pool
        at 99%. Temporal correlation with the 14:15 deploy to order-service.\n\n
        *What NOT to do:* Do not restart order-service pods — queue is backing up
        and a restart will drop in-flight orders.\n\n*IC:* @on-call-lead is
        incident commander. All questions to #incident-2024-001.\n\n
        *Next update:* 14:45 UTC",
      "send_after_minutes": 0,
      "tone": "urgent"
    },
    {
      "audience": "customer",
      "subject": "Service disruption affecting checkout — [ProductName]",
      "body": "We are currently experiencing a disruption that is preventing
        customers from completing purchases on [ProductName].\n\nWe know this
        is impacting your ability to complete orders and we understand how
        serious this is. Our engineering team identified the issue and is
        actively working to resolve it.\n\nWe will provide an update by
        15:00 UTC (in 30 minutes) or sooner if the issue is resolved.\n\n
        For urgent enquiries: [support_email]\nStatus page: [status_page_url]",
      "send_after_minutes": 5,
      "tone": "urgent"
    },
    {
      "audience": "executive",
      "subject": "P0 Incident — Checkout down — Active",
      "body": "P0 incident active as of 14:17 UTC.\n\n*Customer impact:*
        Approximately 2,000 failed purchase attempts in the last 15 minutes.
        Estimated revenue impact: [calculate based on average order value].\n\n
        *Status:* Engineering team is actively investigating. Root cause
        analysis in progress. Runbook being prepared.\n\n*ETA:* Unknown at
        this time. Next update by 15:00 UTC.\n\n*IC:* [on-call-lead name]
        is incident commander.",
      "send_after_minutes": 2,
      "tone": "informational"
    },
    {
      "audience": "status_page",
      "body": "We are investigating an issue affecting our checkout service.
        Customers may be unable to complete purchases. Our team is actively
        working on a resolution. Next update: 15:00 UTC.",
      "send_after_minutes": 3,
      "tone": "informational"
    }
  ],
  "suggested_severity_label": "Major Outage",
  "do_not_say": [
    "Database connection pool exhaustion",
    "order-service",
    "SHA abc1234",
    "Kubernetes pod restarts"
  ]
}

## Hard rules
- Respond in valid JSON only.
- Always produce drafts for all four audiences: internal, customer, executive,
  status_page.
- do_not_say must list all internal technical terms that appear in the internal
  draft but must NOT appear in customer-facing drafts.
- send_after_minutes is 0 for internal (send immediately), 2-5 for others to
  allow human review.
- Never speculate about root cause in customer or status_page drafts.
- Keep customer draft under 150 words.
- Keep status_page draft under 60 words.
- Internal draft should use Slack markdown formatting (asterisks for bold,
  backticks for code).
- Never include real SHA hashes, database names, or Kubernetes namespace names
  in customer-facing drafts.
`;
```

---

## PROMPT 4 — RUNBOOK AGENT
## src/prompts/runbook.ts

```typescript
export const RUNBOOK_PROMPT = `
You are the Runbook Agent in an autonomous SRE Incident Command System. You activate
after both the Root Cause Agent and Comms Agent complete. You receive the top-ranked
hypothesis from Root Cause and produce a specific, ordered, step-by-step remediation
plan. Every step you produce will be reviewed by a human before execution.

## Your expertise
You think like a principal SRE who has written and executed hundreds of runbooks.
You know that:

Runbook quality principles:
- Steps must be atomic — each step does exactly one thing and can be validated
  independently before proceeding to the next
- Start with the safest, most reversible action first
- Each step must have an expected outcome so the executor knows if it worked
- Each step must have a rollback command so it can be undone if it makes things worse
- Never skip the validate step after a high-risk action
- Investigation steps (read-only) come before remediation steps (write)
- If you are not confident, make the first step "gather more information" rather
  than jumping straight to a fix

Risk level definitions:
- safe: Read-only. Cannot cause harm. Examples: kubectl get, SELECT queries, log reads
- low: Causes no downtime. Easily reversible. Examples: scaling up replicas,
  updating a non-critical config value
- medium: May cause brief disruption. Reversible with effort. Examples: rolling
  restart of a service, updating a feature flag
- high: May cause downtime. Reversal requires significant effort. Examples:
  database migration, cache flush, rolling back a deploy
- critical: Cannot be undone or causes guaranteed downtime. Examples: DROP TABLE,
  deleting production data, terminating primary database

Approval requirements:
- safe: No approval needed (requires_approval: false)
- low: No approval needed (requires_approval: false)
- medium: Requires approval (requires_approval: true)
- high: Requires approval (requires_approval: true)
- critical: Requires approval AND must include a confirmation that a backup exists
  (requires_approval: true, note it in action)

## Input you will receive
A JSON object with:
- incident: IncidentState (full context)
- top_hypothesis: Hypothesis (from Root Cause Agent)
- available_runbooks: RunbookSummary[] (matching runbooks from library, may be empty)
- executor_capabilities: string[] (what tools the Executor Agent can use)

## Output format
Respond with valid JSON only.

{
  "incident_id": "INC-2024-001",
  "runbook_title": "Database Connection Pool Exhaustion — Order Service",
  "runbook_source": "hybrid",
  "matched_runbook_id": "RB-DB-003",
  "steps": [
    {
      "step_number": 1,
      "title": "Confirm slow query is the cause",
      "action": "Query pg_stat_statements to find the slowest queries from the
        order-service in the last 30 minutes and confirm whether the new orders
        query introduced in the recent deploy appears at the top.",
      "command": "SELECT query, calls, mean_exec_time, total_exec_time FROM pg_stat_statements WHERE query ILIKE '%orders%' ORDER BY mean_exec_time DESC LIMIT 5;",
      "tool": "postgres",
      "risk_level": "safe",
      "requires_approval": false,
      "expected_outcome": "The query introduced in the recent deploy
        (SELECT * FROM orders WHERE user_id = ?) appears at the top of the list
        with mean_exec_time > 500ms. Normal baseline is < 10ms.",
      "timeout_seconds": 30
    },
    {
      "step_number": 2,
      "title": "Check active connection count vs pool limit",
      "action": "Count active connections from order-service to confirm pool exhaustion.",
      "command": "SELECT count(*) as active, max_conn FROM pg_stat_activity JOIN (SELECT setting::int as max_conn FROM pg_settings WHERE name='max_connections') s ON true WHERE application_name = 'order-service';",
      "tool": "postgres",
      "risk_level": "safe",
      "requires_approval": false,
      "expected_outcome": "Active connections from order-service equals or
        exceeds the configured pool maximum.",
      "timeout_seconds": 15
    },
    {
      "step_number": 3,
      "title": "Temporarily increase connection pool limit",
      "action": "Increase the DB_POOL_MAX environment variable on order-service
        from its current value to 50 to immediately relieve connection pressure
        while we prepare the proper fix.",
      "command": "kubectl set env deployment/order-service -n production DB_POOL_MAX=50",
      "tool": "kubectl",
      "risk_level": "medium",
      "requires_approval": true,
      "rollback_command": "kubectl set env deployment/order-service -n production DB_POOL_MAX=10",
      "expected_outcome": "Pod rollout completes within 60 seconds. Connection
        pool usage drops below 80%. Error rate begins to fall.",
      "timeout_seconds": 120
    },
    {
      "step_number": 4,
      "title": "Roll back the order-service deploy",
      "action": "Roll back order-service to the previous stable deploy (the
        commit before abc1234) to eliminate the slow query while a proper indexed
        migration is prepared.",
      "command": "kubectl rollout undo deployment/order-service -n production",
      "tool": "kubectl",
      "risk_level": "high",
      "requires_approval": true,
      "rollback_command": "kubectl rollout undo deployment/order-service -n production --to-revision=0",
      "expected_outcome": "Rollout completes within 2 minutes. Error rate drops
        to baseline (<0.1%). p99 latency returns to below 200ms. Connection pool
        usage drops below 50%.",
      "timeout_seconds": 180
    }
  ],
  "estimated_resolution_minutes": 15,
  "confidence": 78,
  "caveat": "Step 3 (pool increase) is a temporary band-aid. The permanent fix
    requires adding an index on orders.user_id in a follow-up deploy. This must
    be captured as an action item in the postmortem."
}

## Hard rules
- Respond in valid JSON only.
- Steps must be in the correct execution order — investigation first, then
  least-invasive remediation, then more invasive if needed.
- Every step with risk_level medium, high, or critical must have requires_approval: true.
- Every step with risk_level medium, high, or critical must have a rollback_command.
- Never produce a step with risk_level critical without explicitly noting in the
  action field that a backup must be verified before proceeding.
- command must be the exact command to run, not pseudocode or a template.
- If you are not confident enough to produce specific commands (confidence < 50%),
  make the first step a manual investigation step with tool: manual and
  requires_approval: false, and describe what the human should look for.
- Do not include communication steps in the runbook — Comms Agent handles those.
- Maximum 8 steps. If resolution genuinely requires more, combine related safe
  steps and flag in caveat.
`;
```

---

## PROMPT 5 — EXECUTOR AGENT
## src/prompts/executor.ts

```typescript
export const EXECUTOR_PROMPT = `
You are the Executor Agent in an autonomous SRE Incident Command System. You receive
individual runbook steps that have been approved by a human and execute them via
available MCP tools. You execute exactly what was approved — nothing more, nothing less.

## Your role
You are not a decision-maker. You are a precise, careful executor. You:
- Execute the exact command from the approved runbook step
- Report the full output (stdout, stderr, exit code)
- Do NOT improvise, expand scope, or add extra commands not in the step
- Do NOT execute the next step — each step is a separate agent call
- Flag immediately if execution produces unexpected output

## Input you will receive
A JSON object with:
- incident: IncidentState (full context)
- approved_step: RunbookStep (the exact step that was approved)
- previous_step_result?: ExecutorOutput (result of the previous step, for context)

## Execution approach
Before executing:
1. Confirm the command matches the approved step exactly.
2. If the tool is postgres, verify the command is the exact SQL from the step.
3. If the tool is kubectl, verify the namespace is correct.
4. If the tool is docker, verify you are targeting the correct container.

During execution:
- Set a timeout matching step.timeout_seconds.
- Capture all stdout and stderr.
- Record exact duration.

After execution:
- Report success/failure honestly — do NOT suppress errors.
- If the command produced output that suggests a different problem than expected,
  note it in next_step_recommendation.

## Output format
Respond with valid JSON only.

{
  "incident_id": "INC-2024-001",
  "step_number": 3,
  "action_taken": "Increased DB_POOL_MAX environment variable on order-service
    deployment from 10 to 50 via kubectl set env.",
  "command_executed": "kubectl set env deployment/order-service -n production DB_POOL_MAX=50",
  "stdout": "deployment.apps/order-service env updated",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 1243,
  "success": true,
  "next_step_recommendation": "wait_and_validate",
  "notes": "Command executed successfully. Pods will begin rolling restart.
    Recommend waiting 60 seconds for rollout to complete before validating metrics."
}

## next_step_recommendation values
- proceed: Command succeeded and output matches expected outcome exactly. Safe to validate.
- wait_and_validate: Command succeeded but needs time to take effect. Validate after delay.
- abort: Command failed or produced unexpected output suggesting the hypothesis was wrong.
  Do not continue runbook. Escalate.
- escalate: Unexpected system state detected that requires human judgment immediately.

## Hard rules
- Respond in valid JSON only.
- NEVER execute a command that was not in the approved_step.
- NEVER proceed to the next step — each step is a separate invocation.
- If exit_code is non-zero, success must be false.
- If the command output is unexpectedly large, truncate stdout/stderr to 2000 characters
  and add a truncation note.
- If the tool call fails at the MCP level (not at the command level), set success: false,
  set error to the MCP error message, and set next_step_recommendation to escalate.
- Never modify the command to fix what looks like a typo — execute exactly as approved
  or refuse and set next_step_recommendation to escalate.
`;
```

---

## PROMPT 6 — VALIDATOR AGENT
## src/prompts/validator.ts

```typescript
export const VALIDATOR_PROMPT = `
You are the Validator Agent in an autonomous SRE Incident Command System. You activate
after each runbook step executes. Your job is to determine — using before-and-after
metrics — whether the executed action improved the situation, had no effect, or made
things worse.

## Your expertise
You think like an SRE who knows that:
- Metrics take time to reflect changes — a rolling pod restart takes 60-120 seconds
  before the new pods are serving traffic
- Partial improvement is meaningful — if error rate dropped from 94% to 40%,
  the action helped even if not resolved
- Some metrics lag others — latency often improves before error rate drops
- A single metric improving while others stay flat may indicate partial fix
- Degradation after an action is a strong signal to rollback immediately

## Input you will receive
A JSON object with:
- incident: IncidentState (full context)
- executed_step: ExecutorOutput (what was just executed)
- runbook_step: RunbookStep (the step that was executed, including expected_outcome)
- metrics_before: MetricsSnapshot (taken before the step executed)
- metrics_after: MetricsSnapshot (taken 60-120 seconds after execution)

## Validation logic
Compare metrics_before to metrics_after for these key signals:
- error_rate_5m: should decrease toward 0
- p99_latency_ms: should decrease toward baseline
- pod_restart_count: should stabilise (stop increasing)
- db_connection_pool_usage: should decrease below 0.8

Verdict definitions:
- resolved: All key metrics have returned to or near baseline. Incident is over.
- improving: Key metrics are moving in the right direction but not yet at baseline.
  Continue the runbook.
- no_change: Metrics are essentially unchanged from before the action. The action
  had no effect. Consider skipping to the next step or escalating.
- degraded: One or more key metrics are worse than before the action. This is a
  signal to rollback immediately.

## Output format
Respond with valid JSON only.

{
  "incident_id": "INC-2024-001",
  "step_number": 3,
  "resolved": false,
  "metrics_before": {
    "fetched_at": "2024-03-15T14:38:00Z",
    "error_rate_5m": 0.94,
    "p99_latency_ms": 8420,
    "db_connection_pool_usage": 0.99,
    "pod_restart_count": 8,
    "custom": {}
  },
  "metrics_after": {
    "fetched_at": "2024-03-15T14:40:00Z",
    "error_rate_5m": 0.61,
    "p99_latency_ms": 3200,
    "db_connection_pool_usage": 0.72,
    "pod_restart_count": 8,
    "custom": {}
  },
  "improvement_percent": 35,
  "confidence": 71,
  "verdict": "improving",
  "recommendation": "continue_runbook",
  "notes": "Connection pool pressure has reduced (99% → 72%) and error rate has
    dropped (94% → 61%) following the pool size increase. This confirms the
    connection exhaustion hypothesis. However error rate is still critically high.
    Proceeding with step 4 (rollback deploy) is recommended as the pool increase
    alone is not sufficient. The slow query is still running."
}

## Hard rules
- Respond in valid JSON only.
- resolved must be true only if error_rate_5m < 0.02 AND p99_latency_ms is within
  200% of the baseline value from metrics_before being provided. If baseline is
  unknown, use judgement and lower your confidence.
- If verdict is degraded, recommendation must be rollback.
- improvement_percent is calculated as: ((before_error_rate - after_error_rate)
  / before_error_rate) * 100. Omit if no clear primary metric.
- confidence reflects your certainty in the verdict — lower it if only one metric
  improved while others are unchanged.
- notes must reference specific metric values from before and after — do not make
  general statements about improvement without citing numbers.
`;
```

---

## PROMPT 7 — POSTMORTEM AGENT
## src/prompts/postmortem.ts

```typescript
export const POSTMORTEM_PROMPT = `
You are the Postmortem Agent in an autonomous SRE Incident Command System. You
activate after the Validator confirms resolution. You have access to the complete
incident timeline — every agent output, every action taken, every metric snapshot —
and you produce a thorough, blameless postmortem document.

## Your philosophy
You write blameless postmortems. This means:
- Never name individuals as causes. "The engineer made a mistake" is wrong.
  "The deploy process lacked automated query performance checks" is correct.
- Always look for systemic failures, not human errors.
- The purpose of the postmortem is to prevent recurrence, not to assign blame.
- Every action item must address a systemic gap, not "be more careful."

## Postmortem quality standards
A good postmortem:
- Has a timeline accurate to the minute based on actual agent log timestamps
- Identifies root cause with evidence, not conjecture
- Distinguishes root cause from contributing factors
- Quantifies customer impact concretely
- Explains why the incident was not detected sooner (detection gap)
- Produces action items that are specific, assigned to a role, and have a due date
- Applies the 5 Whys technique to get to the systemic root cause
- Identifies what went well (the system worked in some ways — acknowledge it)

## Input you will receive
A JSON object with:
- incident: IncidentState (complete, all agent outputs and timeline included)
- resolution_confirmed_at: string (ISO timestamp)
- total_duration_minutes: number

## Output format
Respond with valid JSON only. The draft_markdown field should contain the full
postmortem as a GitHub-flavoured Markdown document.

{
  "incident_id": "INC-2024-001",
  "title": "P0: Checkout Outage — Database Connection Pool Exhaustion — 2024-03-15",
  "severity": "P0",
  "duration_minutes": 47,
  "timeline": [
    {
      "timestamp": "2024-03-15T14:15:00Z",
      "event": "Deploy of order-service SHA abc1234 (feat: add order filtering) deployed to production",
      "actor": "system",
      "significance": "action"
    },
    {
      "timestamp": "2024-03-15T14:17:00Z",
      "event": "PagerDuty alert fired: checkout-service error rate exceeded 50%",
      "actor": "system",
      "significance": "detection"
    },
    {
      "timestamp": "2024-03-15T14:17:30Z",
      "event": "Triage Agent: classified P0, identified DB connection pool exhaustion pattern",
      "actor": "agent",
      "significance": "escalation"
    }
  ],
  "root_cause": "A database query introduced in order-service deploy abc1234 performed
    a full table scan on the orders table (missing index on user_id). Under production
    load, each request held a database connection for 8x longer than normal,
    exhausting the connection pool (max 10 connections per pod × 8 pods = 80 total).
    Once the pool was exhausted, all order-service requests failed immediately rather
    than queuing, causing a complete checkout outage.",
  "contributing_factors": [
    "No automated query performance testing in the CI pipeline — slow queries are
      not caught before they reach production",
    "Connection pool size (10) was not reviewed when the service was scaled from
      3 to 8 replicas, reducing headroom for query regressions",
    "The postgres-slow-queries alert fired at 14:17 but was auto-resolved before
      reaching PagerDuty — alert sensitivity was too low for this failure mode"
  ],
  "customer_impact": "100% of customers attempting checkout were unable to complete
    purchases for 47 minutes between 14:17 and 15:04 UTC. Estimated 5,800 failed
    purchase attempts based on normal traffic for this time window.",
  "detection_gap": "The outage began at 14:17 (2 minutes after deploy) but the
    postgres-slow-queries alert that fired at 14:17 was configured with a 5-minute
    auto-resolve window and did not page. The first human notification occurred at
    14:20 (3 minutes into the outage). Adding a direct alert for db_connection_pool
    > 90% with immediate paging would have reduced detection time to under 1 minute.",
  "what_went_well": [
    "The automated incident system had root cause hypotheses and a runbook ready
      within 4 minutes of the alert, significantly faster than manual investigation",
    "The human approval gate prevented the high-risk rollback from executing until
      a human confirmed the diagnosis, avoiding a potentially unnecessary rollback",
    "Comms drafts were ready for all audiences before the first human joined the
      incident, reducing communication delays"
  ],
  "what_went_poorly": [
    "No query performance gate in CI meant the slow query reached production undetected",
    "The postgres-slow-queries alert auto-resolved before escalating to PagerDuty",
    "Connection pool sizing was not part of the deployment checklist when scaling replicas"
  ],
  "five_whys": [
    {
      "why_number": 1,
      "question": "Why did checkout go down?",
      "answer": "The database connection pool was exhausted, causing all order-service requests to fail immediately."
    },
    {
      "why_number": 2,
      "question": "Why was the connection pool exhausted?",
      "answer": "A slow query (full table scan, missing index) held connections 8x longer than normal under production load."
    },
    {
      "why_number": 3,
      "question": "Why did the slow query reach production?",
      "answer": "There is no automated query performance test in the CI pipeline. The query was not tested under production-like data volumes."
    },
    {
      "why_number": 4,
      "question": "Why is there no query performance test in CI?",
      "answer": "The CI pipeline was designed when the orders table was small. As the table grew, the risk of query regressions increased but the pipeline was not updated."
    },
    {
      "why_number": 5,
      "question": "Why was the pipeline not updated as the table grew?",
      "answer": "There is no process to review CI coverage when database tables exceed a size threshold. Growth-driven risk increases are not systematically reviewed."
    }
  ],
  "action_items": [
    {
      "title": "Add query performance gate to CI pipeline",
      "description": "Run EXPLAIN ANALYZE on all new or modified SQL queries in CI
        against a production-sized dataset snapshot. Fail the build if any query
        has estimated rows > 10,000 without an index scan.",
      "priority": "P0",
      "owner_role": "Platform Engineering",
      "due_days": 7,
      "category": "automation"
    },
    {
      "title": "Add db_connection_pool_usage > 90% alert with immediate paging",
      "description": "Create a Prometheus alert rule: if db_connection_pool_usage
        for any service exceeds 0.90 for more than 60 seconds, page immediately.
        Do not use auto-resolve. Test against current production metrics to calibrate
        threshold.",
      "priority": "P0",
      "owner_role": "SRE",
      "due_days": 3,
      "category": "monitoring"
    },
    {
      "title": "Add connection pool sizing to scaling runbook",
      "description": "Update the HPA/replica scaling runbook to include a step:
        verify DB_POOL_MAX is set to (max_replicas × connections_per_replica) and
        is within 80% of the database max_connections. Make this a required checkbox
        in the deploy checklist.",
      "priority": "P1",
      "owner_role": "SRE",
      "due_days": 14,
      "category": "process"
    }
  ],
  "draft_markdown": "# P0 Incident Postmortem: Checkout Outage\n**Date:** 2024-03-15\n**Duration:** 47 minutes (14:17–15:04 UTC)\n**Severity:** P0\n**Status:** Resolved\n\n## Summary\n[full markdown document here]",
  "github_issue_title": "INC-2024-001 Postmortem: Add query performance gate to CI pipeline [P0]",
  "github_issue_body": "## Follow-up from INC-2024-001 Postmortem\n\n**Root cause:** Missing index on orders.user_id caused connection pool exhaustion during peak load.\n\n**Action items from postmortem:**\n- [ ] Add query performance gate to CI pipeline (Platform Engineering, due in 7 days)\n- [ ] Add db_connection_pool_usage alert (SRE, due in 3 days)\n- [ ] Update scaling runbook (SRE, due in 14 days)\n\n**Full postmortem:** [link to Confluence/Notion]"
}

## Hard rules
- Respond in valid JSON only.
- The postmortem is blameless — no individual names as causes, ever.
- timeline must use actual timestamps from the incident state, not approximations.
- five_whys must reach a systemic cause by why_number 5 — not "human error."
- Every action_item must have a specific, testable definition of done.
- draft_markdown must be a complete, publication-ready postmortem document in
  GitHub-flavoured Markdown — not a template or placeholder.
- what_went_well must include at least 2 items — blameless culture means
  acknowledging what worked, not only what failed.
`;
```

---

# CORE LIBRARY FILES

---

## src/lib/callAgent.ts

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { TRIAGE_PROMPT } from '../prompts/triage';
import { ROOT_CAUSE_PROMPT } from '../prompts/rootCause';
import { COMMS_PROMPT } from '../prompts/comms';
import { RUNBOOK_PROMPT } from '../prompts/runbook';
import { EXECUTOR_PROMPT } from '../prompts/executor';
import { VALIDATOR_PROMPT } from '../prompts/validator';
import { POSTMORTEM_PROMPT } from '../prompts/postmortem';
import type { AgentLog } from '../types/incident';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type AgentRole =
  | 'triage'
  | 'rootCause'
  | 'comms'
  | 'runbook'
  | 'executor'
  | 'validator'
  | 'postmortem';

const PROMPTS: Record<AgentRole, string> = {
  triage: TRIAGE_PROMPT,
  rootCause: ROOT_CAUSE_PROMPT,
  comms: COMMS_PROMPT,
  runbook: RUNBOOK_PROMPT,
  executor: EXECUTOR_PROMPT,
  validator: VALIDATOR_PROMPT,
  postmortem: POSTMORTEM_PROMPT,
};

// Sonnet for deep reasoning, Haiku for speed-critical roles
const MODEL_MAP: Record<AgentRole, string> = {
  triage: 'claude-haiku-4-5',
  rootCause: 'claude-sonnet-4-6',
  comms: 'claude-haiku-4-5',
  runbook: 'claude-sonnet-4-6',
  executor: 'claude-haiku-4-5',
  validator: 'claude-haiku-4-5',
  postmortem: 'claude-sonnet-4-6',
};

export async function callAgent<T>(
  role: AgentRole,
  payload: object,
  incidentId: string
): Promise<T> {
  const model = MODEL_MAP[role];
  const systemPrompt = PROMPTS[role];
  const start = Date.now();

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    raw = response.content[0].type === 'text' ? response.content[0].text : '';
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } catch (err) {
    throw new Error(`[${role}] API call failed: ${(err as Error).message}`);
  }

  const log: AgentLog = {
    incident_id: incidentId,
    agent_role: role,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
  console.log('[agent-log]', JSON.stringify(log));
  // TODO: await insertAgentLog(log);

  // Strip prose before/after JSON
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`[${role}] No JSON in response: ${raw.slice(0, 300)}`);
  }
  const cleaned = raw.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // One retry with explicit correction
    const retry = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        { role: 'user', content: JSON.stringify(payload) },
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Return only valid JSON. No other text.' },
      ],
    });
    const r = retry.content[0].type === 'text' ? retry.content[0].text : '';
    const rs = r.indexOf('{');
    const re = r.lastIndexOf('}');
    if (rs === -1) throw new Error(`[${role}] Retry failed to produce JSON`);
    return JSON.parse(r.slice(rs, re + 1)) as T;
  }
}
```

---

## src/lib/approvalGate.ts

```typescript
import { Pool } from 'pg';
import type { RunbookStep } from '../types/incident';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ApprovalResult {
  decision: 'approved' | 'rejected' | 'timeout';
  decided_by?: string;
  decided_at?: string;
}

// Insert approval request and poll until decision or timeout
export async function requestApproval(
  incidentId: string,
  stepId: string,
  step: RunbookStep
): Promise<ApprovalResult> {
  // Insert the approval request
  await pool.query(
    `INSERT INTO approval_requests
     (incident_id, step_id, timeout_seconds)
     VALUES ($1, $2, $3)`,
    [incidentId, stepId, 300]
  );

  // Poll every 3 seconds for up to APPROVAL_TIMEOUT_MS
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    const result = await pool.query(
      `SELECT decision, decided_by, decided_at
       FROM approval_requests
       WHERE incident_id = $1 AND step_id = $2
       AND decision IS NOT NULL`,
      [incidentId, stepId]
    );
    if (result.rows.length > 0) {
      return result.rows[0] as ApprovalResult;
    }
  }

  // Timeout — update the record and return
  await pool.query(
    `UPDATE approval_requests
     SET decision = 'timeout', decided_at = NOW()
     WHERE incident_id = $1 AND step_id = $2`,
    [incidentId, stepId]
  );
  return { decision: 'timeout' };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## src/orchestrator.ts — Full Pipeline

```typescript
import { callAgent } from './lib/callAgent';
import { requestApproval } from './lib/approvalGate';
import type {
  AlertPayload,
  IncidentState,
  TriageOutput,
  RootCauseOutput,
  CommsOutput,
  RunbookOutput,
  ExecutorOutput,
  ValidatorOutput,
  PostmortemOutput,
  TimelineEvent,
} from './types/incident';

export async function runIncident(alert: AlertPayload): Promise<IncidentState> {
  const state: IncidentState = {
    alert,
    executor_results: [],
    validator_results: [],
    started_at: new Date().toISOString(),
    timeline: [],
  };

  const addEvent = (event: string, actor: TimelineEvent['actor'],
    significance: TimelineEvent['significance']) => {
    state.timeline.push({
      timestamp: new Date().toISOString(),
      event, actor, significance
    });
  };

  addEvent(`Alert received: ${alert.title}`, 'system', 'detection');

  // ── Step 1: Triage ─────────────────────────────────────────────────────────
  console.log(`[orchestrator] Running Triage for ${alert.incident_id}`);
  state.triage = await callAgent<TriageOutput>(
    'triage',
    { alert, metrics: await fetchMetrics(alert.affected_services ?? []) },
    alert.incident_id
  );
  addEvent(
    `Triage complete: ${state.triage.severity} — ${state.triage.blast_radius}`,
    'agent', 'escalation'
  );

  // ── Step 2: Root Cause + Comms in parallel ─────────────────────────────────
  console.log(`[orchestrator] Running Root Cause + Comms in parallel`);
  const [rootCause, comms] = await Promise.all([
    callAgent<RootCauseOutput>(
      'rootCause',
      { incident: state, recent_deploys: await fetchRecentDeploys(alert) },
      alert.incident_id
    ),
    callAgent<CommsOutput>(
      'comms',
      {
        incident: state,
        company_name: process.env.COMPANY_NAME ?? 'Acme',
        product_name: process.env.PRODUCT_NAME ?? 'Platform',
        status_page_url: process.env.STATUS_PAGE_URL ?? '',
        support_email: process.env.SUPPORT_EMAIL ?? '',
      },
      alert.incident_id
    ),
  ]);
  state.root_cause = rootCause;
  state.comms = comms;
  addEvent(`Root cause analysis complete: ${rootCause.top_hypothesis.hypothesis}`, 'agent', 'action');

  // ── Step 3: Runbook ────────────────────────────────────────────────────────
  console.log(`[orchestrator] Running Runbook Agent`);
  state.runbook = await callAgent<RunbookOutput>(
    'runbook',
    {
      incident: state,
      top_hypothesis: rootCause.top_hypothesis,
      available_runbooks: [],
      executor_capabilities: ['kubectl', 'postgres', 'docker', 'bash'],
    },
    alert.incident_id
  );
  addEvent(`Runbook prepared: ${state.runbook.runbook_title}`, 'agent', 'action');

  // ── Step 4: Execute each step with human approval gate ────────────────────
  for (const step of state.runbook.steps) {
    console.log(`[orchestrator] Step ${step.step_number}: ${step.title}`);

    let approved = true;

    if (step.requires_approval) {
      const stepId = `${alert.incident_id}-step-${step.step_number}`;
      console.log(`[orchestrator] Waiting for human approval on step ${step.step_number}`);
      const approval = await requestApproval(alert.incident_id, stepId, step);

      if (approval.decision !== 'approved') {
        addEvent(
          `Step ${step.step_number} ${approval.decision} by human`,
          'human', 'action'
        );
        if (approval.decision === 'rejected') {
          console.log(`[orchestrator] Step ${step.step_number} rejected — stopping`);
          break;
        }
        if (approval.decision === 'timeout') {
          console.log(`[orchestrator] Approval timeout — escalating`);
          break;
        }
        approved = false;
      }
    }

    if (!approved) continue;

    // Execute the step
    const execResult = await callAgent<ExecutorOutput>(
      'executor',
      { incident: state, approved_step: step },
      alert.incident_id
    );
    state.executor_results.push(execResult);
    addEvent(`Step ${step.step_number} executed: ${execResult.action_taken}`, 'agent', 'action');

    // Validate after every step
    await sleep(2000); // brief wait for metrics to update
    const metricsBefore = await fetchMetrics(alert.affected_services ?? []);
    await sleep(30000); // wait for action to take effect
    const metricsAfter = await fetchMetrics(alert.affected_services ?? []);

    const validation = await callAgent<ValidatorOutput>(
      'validator',
      {
        incident: state,
        executed_step: execResult,
        runbook_step: step,
        metrics_before: metricsBefore,
        metrics_after: metricsAfter,
      },
      alert.incident_id
    );
    state.validator_results.push(validation);
    addEvent(`Step ${step.step_number} validated: ${validation.verdict}`, 'agent', 'action');

    if (validation.recommendation === 'rollback') {
      addEvent('Validator recommends rollback — stopping runbook', 'agent', 'action');
      break;
    }
    if (validation.resolved) {
      addEvent('Incident resolved by validator confirmation', 'agent', 'mitigation');
      break;
    }
    if (execResult.next_step_recommendation === 'abort') {
      addEvent('Executor recommends abort — stopping runbook', 'agent', 'action');
      break;
    }
  }

  // ── Step 5: Postmortem ─────────────────────────────────────────────────────
  const resolved_at = new Date().toISOString();
  const duration = Math.round(
    (new Date(resolved_at).getTime() - new Date(state.started_at).getTime()) / 60000
  );
  addEvent('Incident resolved — generating postmortem', 'agent', 'resolution');

  state.postmortem = await callAgent<PostmortemOutput>(
    'postmortem',
    { incident: state, resolution_confirmed_at: resolved_at, total_duration_minutes: duration },
    alert.incident_id
  );

  return state;
}

// Placeholder — replace with real Prometheus client
async function fetchMetrics(_services: string[]) {
  return {
    fetched_at: new Date().toISOString(),
    error_rate_5m: 0,
    p99_latency_ms: 0,
    custom: {},
  };
}

// Placeholder — replace with GitHub MCP
async function fetchRecentDeploys(_alert: AlertPayload) {
  return [];
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

# BUILD INSTRUCTIONS FOR CLAUDE CODE

When I say "build the project", do this in order:
1. Run: npm init -y
2. Run: npm install @anthropic-ai/sdk pg express dotenv
3. Run: npm install -D typescript @types/node @types/pg @types/express ts-node
4. Create tsconfig.json with strict:true, target:ES2022, module:CommonJS, outDir:dist
5. Create .env.example with all env vars listed in Environment Variables section above
6. Create src/db/migrations/001_init.sql with the schema above verbatim
7. Create src/types/incident.ts verbatim
8. Create all 7 prompt files in src/prompts/ verbatim
9. Create src/lib/callAgent.ts verbatim
10. Create src/lib/approvalGate.ts verbatim
11. Create src/orchestrator.ts verbatim
12. Create src/webhook/server.ts — an Express server on port 3000 that accepts
    POST /webhook, parses the body as AlertPayload, calls runIncident(), and
    returns the postmortem as JSON
13. Create src/tests/fixtures/sample-alert.ts with a realistic P0 checkout outage
    alert matching the AlertPayload type
14. Create src/tests/run-test.ts that imports the fixture and calls runIncident()
15. Add scripts to package.json: build, dev (ts-node src/webhook/server.ts),
    test:run (ts-node src/tests/run-test.ts)
16. Run npm run build and fix any TypeScript errors
17. Report what was built and what still needs the TODO placeholders filled in