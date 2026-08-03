# IncidentOS

An autonomous SRE incident command system. It activates on a PagerDuty/webhook alert,
runs seven coordinated AI agents to diagnose root cause, prepares runbook remediation
steps, drafts stakeholder communications, and writes the postmortem — with a
**human-in-the-loop approval gate before any remediation action executes**.

## Pipeline

```
Alert Webhook → Triage → [Root Cause ∥ Comms] → Runbook
→ [Human Approval Gate] → Executor → Validator → Postmortem
→ Slack Summary + Postgres Log
```

Root Cause and Comms run in parallel after Triage. Runbook runs once both complete.
The Executor runs a step **only** after explicit human approval; the Validator runs
after each executed step; the Postmortem runs once the incident is confirmed resolved.

## Getting started

```bash
npm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY, DATABASE_URL at minimum

npm run dev                   # webhook server        → http://localhost:3000
npm run dashboard             # approval dashboard     → http://localhost:3001

npm test                      # unit tests (no API key or DB needed)
npm run build:api             # TypeScript build/type check
npm run test:run              # end-to-end run of the sample P0 alert (needs ANTHROPIC_API_KEY)
```

Fire a test alert at a running server (any payload matching `AlertSchema` in
`src/webhook/validation.ts`):

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "incident_id": "INC-DEMO-001",
    "title": "P0: checkout-service error rate exceeded 90%",
    "alert_source": "pagerduty",
    "affected_services": ["checkout-service", "payment-gateway"],
    "started_at": "2026-08-03T12:00:00.000Z",
    "raw": {}
  }'
```

The canonical end-to-end fixture lives in `src/tests/fixtures/sample-alert.ts` and is
exercised by `npm run test:run`.

## Architecture

| Layer | Location | Notes |
|-------|----------|-------|
| Agents | `src/agents/` | Typed wrappers — import these, never `callAgent` directly |
| Prompts | `src/prompts/` | One system prompt per agent |
| LLM entry point | `src/lib/callAgent.ts` | The only place Anthropic is called; logs tokens/duration per call |
| External I/O | `src/lib/mcpClient.ts` | Slack (`@slack/web-api`) + GitHub (`@octokit/rest`) |
| Metrics | `src/lib/metricsClient.ts` | Prometheus + Grafana; SSRF-guarded; zeros if unset |
| Approval gate | `src/lib/approvalGate.ts` | Polls Postgres for a human decision (5-min timeout) |
| Persistence | `src/lib/incidentStore.ts` | Every agent output → Postgres (Neon) |
| Orchestrator | `src/orchestrator.ts` | Wires the full pipeline |
| Webhook | `src/webhook/server.ts` | Express :3000, `POST /webhook`, `GET /health` |
| Dashboard | `src/app/` | Next.js App Router :3001, approve/reject UI |

**Model routing:** Sonnet (`claude-sonnet-4-6`) for deep reasoning (Root Cause,
Runbook, Postmortem); Haiku (`claude-haiku-4-5`) for speed-critical roles (Triage,
Comms, Executor, Validator).

## Security posture

- **Webhook authenticity** — HMAC-SHA256 signature verification (`PAGERDUTY_WEBHOOK_SECRET`),
  timing-safe, supports rotated signatures.
- **Input validation** — strict Zod schema on every alert; `helmet` headers; 512 KB body cap;
  rate limiting (20 req/min/IP). Link hrefs are restricted to `http(s)` (no `javascript:`/`data:`).
- **Human-in-the-loop** — no remediation runs without an explicit approval recorded in Postgres.
- **Command safety filter** — even after approval, a hard denylist blocks catastrophic
  patterns (root `rm`, `mkfs`/`dd`, `DROP`/`TRUNCATE`, cluster-level `kubectl delete`,
  shell substitution, download-and-execute, setuid, `/etc` tampering). Real execution is
  **off by default** (`ENABLE_REAL_EXECUTION=false`).
- **SSRF guard** — `PROMETHEUS_URL`/`GRAFANA_URL` must be `http(s)` and may not resolve to
  cloud metadata / loopback hosts (IPv4 and IPv6).
- **Dashboard auth** — `POST /api/approve` requires a bearer token when `DASHBOARD_API_KEY`
  is set (timing-safe compare); open in local dev when unset.
- **Least leakage** — 5xx responses never echo internal error detail; parameterized SQL
  throughout; graceful SIGTERM/SIGINT drain.

The security-critical pure functions (command denylist, SSRF guard, signature
verification, alert schema) are covered by unit tests in `src/tests/unit/` so a
regression in a filter regex fails CI rather than shipping silently.

## Testing

- `npm test` — Vitest unit suite (`src/tests/unit/`). No API key or database required.
- `npm run test:run` — end-to-end: fires a realistic P0 checkout-outage alert through the
  full pipeline. Requires `ANTHROPIC_API_KEY`; set `TEST_AUTO_APPROVE=true` to skip the
  human approval poll in CI.

CI (`.github/workflows/ci.yml`) runs the build, unit tests, and `npm audit` on every push/PR.

## Environment variables

See `.env.example` for the full annotated list. Required: `ANTHROPIC_API_KEY`,
`DATABASE_URL`. Everything else (Slack, GitHub, Prometheus, Grafana, branding, execution,
timing) is optional and degrades gracefully when unset.

## Database

Postgres (Neon). Schema and indexes live in `src/db/migrations/`. Re-run idempotently:

```bash
node -e "require('dotenv').config(); const {Pool}=require('pg'); const fs=require('fs'); \
  const p=new Pool({connectionString:process.env.DATABASE_URL}); \
  p.query(fs.readFileSync('./src/db/migrations/001_init.sql','utf8')).then(()=>{console.log('done');p.end()});"
```
