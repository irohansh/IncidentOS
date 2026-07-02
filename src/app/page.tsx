import { getIncidents } from '../dashboard/lib/db';

export const dynamic = 'force-dynamic';

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function IncidentListPage() {
  const incidents = await getIncidents();

  return (
    <>
      <div className="page-header">
        <h1>Incidents</h1>
        <p>Active and historical incidents — click to review and approve runbook steps</p>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {incidents.length === 0 ? (
          <div className="empty-state">
            <p>No incidents yet.</p>
            <p style={{ marginTop: 8, fontSize: 12 }}>
              POST to <code style={{ color: '#60a5fa' }}>http://localhost:3000/webhook</code> to trigger one.
            </p>
          </div>
        ) : (
          <>
            <div className="incident-row" style={{ borderBottom: '1px solid #27272a', color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              <div>Sev</div>
              <div>Incident</div>
              <div>Status</div>
              <div>Source</div>
              <div>Started</div>
            </div>
            {incidents.map((inc) => (
              <a key={inc.incident_id} href={`/incidents/${inc.incident_id}`} style={{ display: 'block', textDecoration: 'none' }}>
                <div className="incident-row">
                  <div><span className={`badge badge-${inc.severity}`}>{inc.severity}</span></div>
                  <div>
                    <div className="incident-title">{inc.title}</div>
                    <div className="incident-meta">{inc.incident_id} · {inc.affected_services?.join(', ')}</div>
                  </div>
                  <div><span className={`badge badge-${inc.status}`}>{inc.status}</span></div>
                  <div style={{ color: '#64748b', fontSize: 12 }}>{inc.alert_source}</div>
                  <div style={{ color: '#64748b', fontSize: 12 }}>{timeAgo(inc.started_at)}</div>
                </div>
              </a>
            ))}
          </>
        )}
      </div>
    </>
  );
}
