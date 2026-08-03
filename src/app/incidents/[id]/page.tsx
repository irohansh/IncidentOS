'use client';

import { useEffect, useState, useCallback, use } from 'react';

interface Incident {
  incident_id: string; title: string; severity: string; status: string;
  affected_services: string[]; started_at: string; resolved_at: string | null;
}
interface Step {
  id: string; step_number: number; action: string; command: string | null;
  tool: string; risk_level: string; requires_approval: boolean; status: string; result: string | null;
}
interface Approval {
  id: string; step_id: string; decision: string | null; decided_by: string | null; requested_at: string;
}
interface AgentLog {
  agent_role: string; model: string; input_tokens: number; output_tokens: number; duration_ms: number; timestamp: string;
}
interface Triage {
  severity: string; blast_radius: string; customer_impact: string; confidence: number;
}
interface Hypothesis {
  hypothesis: string; confidence: number; category: string; supporting_evidence: string[];
}
interface Postmortem {
  root_cause: string; customer_impact: string; draft_markdown: string; github_issue_url: string | null;
}

interface IncidentDetail {
  incident: Incident | null;
  steps: Step[];
  approvals: Approval[];
  logs: AgentLog[];
  triage: Triage | null;
  hypothesis: Hypothesis | null;
  postmortem: Postmortem | null;
}

async function fetchDetail(id: string): Promise<IncidentDetail> {
  const res = await fetch(`/api/incidents/${id}`, { cache: 'no-store' });
  return res.json();
}

function Badge({ text, type }: { text: string; type: string }) {
  return <span className={`badge badge-${type}`}>{text}</span>;
}

function ApprovalPanel({ step, approval, onDecide }: {
  step: Step;
  approval: Approval | undefined;
  onDecide: (stepId: string, decision: 'approved' | 'rejected', by: string) => void;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  if (!step.requires_approval) return null;

  if (approval?.decision) {
    const cls = approval.decision === 'approved' ? 'badge-P3' : 'badge-P0';
    return (
      <div style={{ marginTop: 8 }}>
        <span className={`badge ${cls}`}>{approval.decision.toUpperCase()}</span>
        {approval.decided_by && <span style={{ color: '#64748b', fontSize: 12, marginLeft: 8 }}>by {approval.decided_by}</span>}
      </div>
    );
  }

  if (!approval) return null; // not yet queued for approval

  return (
    <div className="alert alert-warning" style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Awaiting human approval</div>
      <div className="approve-form">
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button
          className="btn btn-approve"
          disabled={!name || loading}
          onClick={async () => {
            setLoading(true);
            await onDecide(step.id, 'approved', name);
            setLoading(false);
          }}
        >
          {loading ? '…' : 'Approve'}
        </button>
        <button
          className="btn btn-reject"
          disabled={!name || loading}
          onClick={async () => {
            setLoading(true);
            await onDecide(step.id, 'rejected', name);
            setLoading(false);
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await fetchDetail(id);
      setData(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // auto-refresh every 5s
    return () => clearInterval(t);
  }, [load]);

  const handleDecide = async (stepId: string, decision: 'approved' | 'rejected', by: string) => {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step_id: stepId, decision, decided_by: by }),
    });
    await load();
  };

  if (error) return <div className="alert alert-warning" style={{ marginTop: 24 }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, color: '#64748b' }}>Loading…</div>;

  const { incident, steps, approvals, logs, triage, hypothesis, postmortem } = data;
  if (!incident) return <div style={{ padding: 40, color: '#64748b' }}>Incident not found.</div>;

  const approvalMap = new Map(approvals.map(a => [a.step_id, a]));

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <a href="/" style={{ color: '#64748b', fontSize: 13 }}>← All Incidents</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Badge text={incident.severity} type={incident.severity} />
          <h1 style={{ fontSize: 18 }}>{incident.title}</h1>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 8, color: '#64748b', fontSize: 12 }}>
          <Badge text={incident.status} type={incident.status} />
          <span>{incident.incident_id}</span>
          <span>Started {new Date(incident.started_at).toLocaleString()}</span>
          {incident.resolved_at && <span>Resolved {new Date(incident.resolved_at).toLocaleString()}</span>}
        </div>
        <div className="refresh-note">Auto-refreshing every 5 seconds</div>
      </div>

      {triage && (
        <>
          <div className="section-label">Triage</div>
          <div className="card">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div className="card h3">Blast Radius</div>
                <p style={{ color: '#cbd5e1', fontSize: 13 }}>{triage.blast_radius}</p>
              </div>
              <div>
                <div className="card h3">Customer Impact</div>
                <p style={{ color: '#cbd5e1', fontSize: 13 }}>{triage.customer_impact}</p>
              </div>
            </div>
            <div style={{ marginTop: 12, color: '#64748b', fontSize: 12 }}>Confidence: {triage.confidence}%</div>
          </div>
        </>
      )}

      {hypothesis && (
        <>
          <div className="section-label">Top Root Cause Hypothesis</div>
          <div className="card">
            <div className="card-header">
              <Badge text={hypothesis.category} type="medium" />
              <span style={{ color: '#64748b', fontSize: 12 }}>Confidence: {hypothesis.confidence}%</span>
            </div>
            <p style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 12 }}>{hypothesis.hypothesis}</p>
            {hypothesis.supporting_evidence?.length > 0 && (
              <ul style={{ color: '#94a3b8', fontSize: 12, paddingLeft: 20 }}>
                {hypothesis.supporting_evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        </>
      )}

      {steps.length > 0 && (
        <>
          <div className="section-label">Runbook Steps</div>
          {steps.map(step => {
            const approval = approvalMap.get(step.id);
            const cls = approval?.decision === 'approved' ? 'approved'
              : step.status === 'done' ? 'done'
              : approval && !approval.decision ? 'needs-approval'
              : '';
            return (
              <div key={step.id} className={`step-row ${cls}`}>
                <div className="step-header">
                  <span className="step-num">{step.step_number}</span>
                  <span className="step-title">{step.action.slice(0, 80)}{step.action.length > 80 ? '…' : ''}</span>
                  <Badge text={step.risk_level} type={step.risk_level} />
                  <Badge text={step.status} type={step.status === 'done' ? 'P3' : step.status === 'approved' ? 'P2' : 'medium'} />
                </div>
                {step.command && <pre className="command">{step.command}</pre>}
                {step.result && (
                  <div style={{ color: '#86efac', fontSize: 12, marginTop: 6 }}>Result: {step.result.slice(0, 200)}</div>
                )}
                <ApprovalPanel step={step} approval={approval} onDecide={handleDecide} />
              </div>
            );
          })}
        </>
      )}

      {postmortem && (
        <>
          <div className="section-label">Postmortem</div>
          <div className="card">
            <div className="card h3">Root Cause</div>
            <p style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 12 }}>{postmortem.root_cause}</p>
            <div className="card h3">Customer Impact</div>
            <p style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 12 }}>{postmortem.customer_impact}</p>
            {postmortem.github_issue_url && (
              <div style={{ marginBottom: 12 }}>
                <a href={postmortem.github_issue_url} target="_blank" rel="noreferrer">
                  View GitHub Follow-up Issue →
                </a>
              </div>
            )}
            <div className="card h3">Full Document</div>
            <div className="markdown-preview">{postmortem.draft_markdown}</div>
          </div>
        </>
      )}

      {logs.length > 0 && (
        <>
          <div className="section-label">Agent Log</div>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Agent</th><th>Model</th><th>In Tokens</th><th>Out Tokens</th><th>Duration</th><th>Time</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l, i) => (
                  <tr key={i}>
                    <td>{l.agent_role}</td>
                    <td style={{ color: '#64748b' }}>{l.model}</td>
                    <td>{l.input_tokens?.toLocaleString()}</td>
                    <td>{l.output_tokens?.toLocaleString()}</td>
                    <td>{l.duration_ms}ms</td>
                    <td style={{ color: '#64748b' }}>{new Date(l.timestamp).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
